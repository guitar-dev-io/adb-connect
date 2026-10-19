package dev.adbconnect.core

import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** A device the user explicitly connected or paired. Only these are ever reconnected automatically. No secrets. */
data class KnownDevice(
    val id: String,
    val name: String,
    val guid: String? = null,
    val serialNo: String? = null,
    val lastEndpoint: String? = null,
    val pairedAt: Long? = null,
    val lastConnectedAt: Long? = null,
    val autoReconnect: Boolean = true,
    val userDisconnected: Boolean = false,
)

interface KnownDeviceStore {
    fun load(): List<KnownDevice>
    fun save(devices: List<KnownDevice>)
}

class MemoryKnownDeviceStore(private var devices: List<KnownDevice> = emptyList()) : KnownDeviceStore {
    override fun load() = devices
    override fun save(devices: List<KnownDevice>) { this.devices = devices }
}

enum class ReconnectReason { MANUAL, STARTUP, ADVERTISED, DROPPED }

data class ConnectResult(val ok: Boolean, val message: String, val device: KnownDevice? = null)

/**
 * Manual connect/disconnect and the auto-reconnect policy (same as packages/core ConnectionManager):
 * approved devices only; never after a manual disconnect or with auto-reconnect off; only to a device
 * that is currently advertising (follows IP/port changes); one attempt in flight per device; bounded retries.
 */
class ConnectionManager(
    private val client: AdbClient,
    private val tracker: DeviceTracker,
    private val browser: MdnsBrowser,
    private val store: KnownDeviceStore,
    @Volatile var autoReconnect: Boolean,
    private val log: AdbLog,
    private val maxAttempts: Int = 3,
    private val retryDelayMs: Long = 2_000,
) {
    @Volatile var known: List<KnownDevice> = store.load(); private set
    private val failures = ConcurrentHashMap<String, Int>()
    private val inFlight = ConcurrentHashMap<String, CompletableFuture<ConnectResult>>()
    private val retries = ConcurrentHashMap<String, ScheduledFuture<*>>()
    private val reconnecting = AtomicInteger()
    private val executor = Executors.newScheduledThreadPool(2) { r -> Thread(r, "adb-connect-reconnect").apply { isDaemon = true } }
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    @Volatile private var lastDevices: List<Device> = emptyList()
    @Volatile private var mdnsOk = true

    val isReconnecting: Boolean get() = reconnecting.get() > 0
    var onGaveUp: (KnownDevice, String) -> Unit = { _, _ -> }

    private val deviceListener: (List<Device>) -> Unit = { handleDevices(it) }
    private val serviceListener: (List<MdnsService>, List<MdnsService>) -> Unit = { _, added -> added.forEach(::handleAdvertised) }

    init {
        tracker.addListener(deviceListener)
        browser.addListener(serviceListener)
    }

    fun addListener(l: () -> Unit) { listeners += l }

    fun dispose() {
        tracker.removeListener(deviceListener)
        browser.removeListener(serviceListener)
        retries.values.forEach { it.cancel(false) }
        executor.shutdownNow()
    }

    fun match(d: Device): KnownDevice? = known.firstOrNull { k ->
        (k.guid != null && d.mdnsName == k.guid) || (k.lastEndpoint != null && d.endpoint == k.lastEndpoint) ||
            (k.serialNo != null && d.transport == Transport.USB && d.serial == k.serialNo)
    }

    fun isConnected(k: KnownDevice, list: List<Device> = tracker.devices) =
        list.any { it.state == "device" && it.transport == Transport.WIFI && match(it)?.id == k.id }

    fun connectEndpoint(endpoint: String, name: String? = null): ConnectResult {
        if (!Endpoints.valid(endpoint)) return ConnectResult(false, "Invalid host:port")
        val r = client.connect(endpoint)
        if (!r.ok) return ConnectResult(false, r.message)
        return ConnectResult(true, r.message, remember(endpoint, name = name))
    }

    fun recordPairing(u: PairingUpdate): KnownDevice? {
        if (u.state != PairingState.CONNECTED && u.state != PairingState.PAIRED) return null
        val now = System.currentTimeMillis()
        if (u.endpoint != null) return remember(u.endpoint, u.guid, u.device?.model, now, u.state == PairingState.CONNECTED)
        if (u.guid != null && known.none { it.guid == u.guid }) {
            val k = KnownDevice(u.guid, u.device?.model ?: u.guid, guid = u.guid, pairedAt = now)
            persist(known + k)
            return k
        }
        return known.firstOrNull { it.guid == u.guid }
    }

    fun disconnect(serial: String): OpResult {
        val live = tracker.devices.firstOrNull { it.serial == serial }
        val k = live?.let(::match) ?: known.firstOrNull { it.lastEndpoint == serial }
        if (k != null) {
            retries.remove(k.id)?.cancel(false)
            update(k.id) { it.copy(userDisconnected = true) }
        }
        return client.disconnect(serial)
    }

    fun forget(id: String) {
        retries.remove(id)?.cancel(false)
        failures.remove(id)
        persist(known.filter { it.id != id })
    }

    fun setDeviceAutoReconnect(id: String, on: Boolean) = update(id) { it.copy(autoReconnect = on) }

    /** Reconnect one device; concurrent calls for the same device share one attempt. Blocking. */
    fun reconnect(id: String, reason: ReconnectReason): ConnectResult {
        // Runs on the caller's thread; a second caller for the same device waits for the first attempt.
        val mine = CompletableFuture<ConnectResult>()
        inFlight.putIfAbsent(id, mine)?.let { return it.get() }
        try {
            return doReconnect(id, reason).also { mine.complete(it) }
        } catch (e: Exception) {
            mine.completeExceptionally(e)
            throw e
        } finally {
            inFlight.remove(id)
        }
    }

    fun reconnectAll(reason: ReconnectReason): List<ConnectResult> {
        mdnsOk = client.mdnsAvailable()
        if (mdnsOk) runCatching { browser.refresh() }
        return known.filter { if (reason == ReconnectReason.MANUAL) !it.userDisconnected else eligible(it) }.map { reconnect(it.id, reason) }
    }

    private fun eligible(k: KnownDevice) = autoReconnect && k.autoReconnect && !k.userDisconnected && (failures[k.id] ?: 0) < maxAttempts

    private fun doReconnect(id: String, reason: ReconnectReason): ConnectResult {
        var k = known.firstOrNull { it.id == id } ?: return ConnectResult(false, "Unknown device")
        if (reason == ReconnectReason.MANUAL) {
            failures.remove(id)
            if (k.userDisconnected) k = update(id) { it.copy(userDisconnected = false) } ?: k
        } else if (!eligible(k)) return ConnectResult(false, "Automatic reconnection not allowed for this device", k)
        if (isConnected(k)) return ConnectResult(true, "Already connected", k)

        if (k.guid != null && reason != ReconnectReason.ADVERTISED && !browser.active) runCatching { browser.refresh() }
        val advertised = k.guid?.let { g -> browser.services.firstOrNull { it.type == ServiceType.CONNECT && it.name == g } }
        // Blind attempts to an old endpoint only when the user asked, or mDNS can't tell us anything.
        val endpoint = advertised?.endpoint ?: (if (reason == ReconnectReason.MANUAL || !mdnsOk) k.lastEndpoint else null)
            ?: return ConnectResult(false, "${k.name} is not advertising. Is Wireless debugging on and the phone on this network?", k)

        changeReconnecting(+1)
        try {
            val r = client.connect(endpoint)
            if (r.ok) {
                failures.remove(id)
                val updated = update(id) { it.copy(lastEndpoint = endpoint, lastConnectedAt = System.currentTimeMillis()) }
                log.log(LogLevel.INFO, "Reconnected ${k.name} at $endpoint ($reason)")
                return ConnectResult(true, r.message, updated)
            }
            return recordFailure(k, r.message, reason)
        } catch (e: Exception) {
            return recordFailure(k, e.message ?: "connect failed", reason)
        } finally {
            changeReconnecting(-1)
        }
    }

    private fun recordFailure(k: KnownDevice, message: String, reason: ReconnectReason): ConnectResult {
        if (reason != ReconnectReason.MANUAL) {
            val n = failures.merge(k.id, 1, Int::plus)!!
            log.log(LogLevel.WARN, "Reconnect ${k.name} failed ($n/$maxAttempts, $reason): $message")
            if (n >= maxAttempts) onGaveUp(k, message)
        }
        return ConnectResult(false, message, k)
    }

    private fun handleAdvertised(s: MdnsService) {
        if (s.type != ServiceType.CONNECT) return
        val k = known.firstOrNull { it.guid == s.name } ?: return // never auto-connect unknown devices
        if (s.endpoint != k.lastEndpoint) failures.remove(k.id)
        if (eligible(k) && !isConnected(k)) executor.execute { reconnect(k.id, ReconnectReason.ADVERTISED) }
    }

    private fun handleDevices(list: List<Device>) {
        val before = lastDevices
        lastDevices = list
        for (k in known) {
            val was = isConnected(k, before)
            val now = isConnected(k, list)
            if (now) retries.remove(k.id)?.cancel(false)
            else if (was && eligible(k)) scheduleRetry(k.id, 0)
        }
        listeners.forEach { it() }
    }

    private fun scheduleRetry(id: String, attempt: Int) {
        if (retries.containsKey(id) || executor.isShutdown) return
        retries[id] = executor.schedule({
            retries.remove(id)
            val r = reconnect(id, ReconnectReason.DROPPED)
            val k = known.firstOrNull { it.id == id }
            if (!r.ok && k != null && eligible(k)) scheduleRetry(id, attempt + 1)
        }, retryDelayMs * (1L shl attempt), TimeUnit.MILLISECONDS)
    }

    private fun changeReconnecting(delta: Int) {
        reconnecting.addAndGet(delta)
        listeners.forEach { it() }
    }

    private fun remember(endpoint: String, guid: String? = null, name: String? = null, pairedAt: Long? = null, connected: Boolean = true): KnownDevice {
        val live = runCatching { client.devices() }.getOrDefault(emptyList()).firstOrNull { it.endpoint == endpoint || (guid != null && it.mdnsName == guid) }
        val g = guid ?: live?.mdnsName ?: browser.services.firstOrNull { it.type == ServiceType.CONNECT && it.endpoint == endpoint }?.name
        val serialNo = if (live?.state == "device") runCatching { client.getProp(live.serial, "ro.serialno") }.getOrNull() else null
        val existing = known.firstOrNull { (g != null && it.guid == g) || (serialNo != null && it.serialNo == serialNo) || it.lastEndpoint == endpoint }
        val next = KnownDevice(
            id = existing?.id ?: g ?: serialNo ?: endpoint,
            name = name ?: live?.model ?: existing?.name ?: endpoint,
            guid = g ?: existing?.guid,
            serialNo = serialNo ?: existing?.serialNo,
            lastEndpoint = endpoint,
            pairedAt = pairedAt ?: existing?.pairedAt,
            lastConnectedAt = if (connected) System.currentTimeMillis() else existing?.lastConnectedAt,
            autoReconnect = existing?.autoReconnect ?: true,
            userDisconnected = false,
        )
        failures.remove(next.id)
        persist(if (existing != null) known.map { if (it.id == existing.id) next else it } else known + next)
        return next
    }

    private fun update(id: String, patch: (KnownDevice) -> KnownDevice): KnownDevice? {
        var updated: KnownDevice? = null
        val next = known.map { if (it.id == id) patch(it).also { u -> updated = u } else it }
        if (updated != null) persist(next)
        return updated
    }

    @Synchronized
    private fun persist(list: List<KnownDevice>) {
        known = list
        store.save(list)
        listeners.forEach { it() }
    }
}

enum class EntryStatus(val label: String) {
    CONNECTED("Connected"), CONNECTING("Connecting"), UNAUTHORIZED("Unauthorized — allow on phone"),
    OFFLINE("Offline"), AVAILABLE("Available"), DISCONNECTED("Disconnected"), OTHER("Other")
}

/** One device-manager row: live adb device, remembered device, or advertising device. */
data class DeviceEntry(
    val id: String,
    val name: String,
    val serial: String?,
    val endpoint: String?,
    val transport: Transport,
    val status: EntryStatus,
    val known: Boolean,
    val paired: Boolean,
    val preferred: Boolean,
    val autoReconnect: Boolean? = null,
    val userDisconnected: Boolean? = null,
    val advertisedName: String? = null,
) {
    fun adbCommands(): List<Pair<String, String>> {
        val out = mutableListOf<Pair<String, String>>()
        val target = serial ?: endpoint
        if (endpoint != null && transport == Transport.WIFI) out += "Connect" to "adb connect $endpoint"
        if (target != null) {
            out += "Shell" to "adb -s $target shell"
            out += "Logcat" to "adb -s $target logcat"
            out += "Install APK" to "adb -s $target install -r app.apk"
        }
        if (serial != null && transport == Transport.WIFI) out += "Disconnect" to "adb disconnect $serial"
        return out
    }
}

object DeviceModel {
    fun build(devices: List<Device>, known: List<KnownDevice>, services: List<MdnsService>, match: (Device) -> KnownDevice?, preferredId: String?): List<DeviceEntry> {
        val entries = mutableListOf<DeviceEntry>()
        val seenKnown = mutableSetOf<String>()
        val seenGuids = mutableSetOf<String>()
        for (d in devices) {
            val k = match(d)
            if (k != null && d.transport == Transport.WIFI) seenKnown += k.id
            d.mdnsName?.let { seenGuids += it }
            val adv = d.mdnsName?.let { g -> services.firstOrNull { it.type == ServiceType.CONNECT && it.name == g } }
            val id = if (k != null && d.transport == Transport.WIFI) k.id else d.serial
            entries += DeviceEntry(
                id = id,
                name = if (k != null && d.model == d.serial) k.name else d.model,
                serial = d.serial,
                endpoint = d.endpoint ?: adv?.endpoint ?: if (d.transport == Transport.WIFI) k?.lastEndpoint else null,
                transport = d.transport,
                status = when (d.state) {
                    "device" -> EntryStatus.CONNECTED; "offline" -> EntryStatus.OFFLINE; "unauthorized" -> EntryStatus.UNAUTHORIZED
                    "authorizing", "connecting" -> EntryStatus.CONNECTING; else -> EntryStatus.OTHER
                },
                known = k != null,
                paired = k?.pairedAt != null || d.transport == Transport.WIFI,
                preferred = id == preferredId || d.serial == preferredId,
                autoReconnect = k?.autoReconnect,
                userDisconnected = k?.userDisconnected,
            )
        }
        for (k in known) {
            if (k.id in seenKnown) continue
            k.guid?.let { seenGuids += it }
            val adv = k.guid?.let { g -> services.firstOrNull { it.type == ServiceType.CONNECT && it.name == g } }
            entries += DeviceEntry(k.id, k.name, null, adv?.endpoint ?: k.lastEndpoint, Transport.WIFI,
                if (adv != null) EntryStatus.AVAILABLE else EntryStatus.DISCONNECTED, true, k.pairedAt != null || k.guid != null,
                k.id == preferredId, k.autoReconnect, k.userDisconnected)
        }
        for (s in services) {
            if (s.type != ServiceType.CONNECT || s.name in seenGuids || entries.any { it.endpoint == s.endpoint }) continue
            entries += DeviceEntry("mdns:${s.name}", s.name, null, s.endpoint, Transport.WIFI, EntryStatus.AVAILABLE, false, false, false, advertisedName = s.name)
        }
        return entries.sortedWith(compareBy<DeviceEntry>({ !it.preferred }, { it.status.ordinal }, { it.name.lowercase() }))
    }
}
