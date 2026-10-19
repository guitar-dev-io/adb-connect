package dev.adbconnect.ide

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.Logger
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import dev.adbconnect.core.AdbClient
import dev.adbconnect.core.AdbException
import dev.adbconnect.core.AdbLog
import dev.adbconnect.core.ConnectionManager
import dev.adbconnect.core.DeviceEntry
import dev.adbconnect.core.DeviceModel
import dev.adbconnect.core.DeviceTracker
import dev.adbconnect.core.EntryStatus
import dev.adbconnect.core.LogLevel
import dev.adbconnect.core.MdnsBrowser
import dev.adbconnect.core.ReconnectReason
import dev.adbconnect.core.Transport
import java.text.SimpleDateFormat
import java.util.Date
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

enum class Activity { STARTING, NO_ADB, IDLE, SEARCHING, RECONNECTING, PAIRING }

/** In-memory log (shown in the tool window) mirrored to idea.log. */
class AdbConnectLog {
    private val lines = ArrayDeque<String>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val idea = Logger.getInstance("dev.adbconnect")
    private val fmt = SimpleDateFormat("HH:mm:ss.SSS")
    var debugEnabled = false

    val adbLog = AdbLog { level, message -> log(level, message) }

    fun log(level: LogLevel, message: String) {
        when (level) {
            LogLevel.DEBUG -> { idea.debug(message); if (!debugEnabled) return }
            LogLevel.INFO -> idea.info(message)
            LogLevel.WARN -> idea.warn(message)
            LogLevel.ERROR -> idea.warn(message)
        }
        synchronized(lines) {
            lines.addLast("${fmt.format(Date())} [${level.name.lowercase()}] $message")
            while (lines.size > 2000) lines.removeFirst()
        }
        listeners.forEach { it() }
    }

    fun text(): String = synchronized(lines) { lines.joinToString("\n") }
    fun clear() { synchronized(lines) { lines.clear() }; listeners.forEach { it() } }
    fun addListener(parent: Disposable, l: () -> Unit) { listeners += l; Disposer.register(parent) { listeners -= l } }
}

/**
 * Application-wide engine: one adb client, device tracker, mDNS browser and connection manager
 * shared by every project window.
 */
@Service(Service.Level.APP)
class AdbConnectService : Disposable {
    val log = AdbConnectLog()
    @Volatile var client: AdbClient? = null; private set
    @Volatile var tracker: DeviceTracker? = null; private set
    @Volatile var browser: MdnsBrowser? = null; private set
    @Volatile var connections: ConnectionManager? = null; private set
    @Volatile var startError: String? = null; private set
    @Volatile var pairing = false
        set(v) { field = v; fire() }
    private val searching = AtomicInteger()
    private var discoverLease: MdnsBrowser.Lease? = null
    private val started = AtomicBoolean(false)
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private val settings get() = AdbConnectSettings.get()

    fun addListener(parent: Disposable, l: () -> Unit) {
        listeners += l
        Disposer.register(parent) { listeners -= l }
    }

    private fun fire() = listeners.forEach { runCatching { it() } }

    fun ensureStarted() {
        if (!started.compareAndSet(false, true)) return
        pooled {
            restart()
            if (client != null && settings.autoReconnect && settings.reconnectOnStartup) {
                val rs = connections!!.reconnectAll(ReconnectReason.STARTUP)
                if (rs.isNotEmpty()) log.log(LogLevel.INFO, "Startup reconnect: ${rs.count { it.ok }}/${rs.size} device(s) connected")
            }
        }
    }

    @Synchronized
    fun restart() {
        stopEngine()
        log.debugEnabled = settings.debugLogging
        try {
            val c = AdbClient.create(settings.adbPath, log.adbLog)
            val t = DeviceTracker(c.runner, log.adbLog)
            val b = MdnsBrowser(c, log.adbLog)
            val m = ConnectionManager(c, t, b, settings, settings.autoReconnect, log.adbLog)
            m.onGaveUp = { k, msg -> log.log(LogLevel.WARN, "Stopped reconnecting ${k.name} after repeated failures: $msg") }
            t.addListener { fire() }
            b.addListener { _, _ -> fire() }
            m.addListener { fire() }
            client = c; tracker = t; browser = b; connections = m; startError = null
            val v = c.info.version
            log.log(LogLevel.INFO, "Using adb ${v.adb} (platform-tools ${v.platformTools ?: "unknown"}) at ${c.info.location.path} [${c.info.location.source}]")
            if (!v.wirelessPairing) log.log(LogLevel.WARN, "This adb is too old for wireless pairing (needs platform-tools 31+). Connect by IP still works.")
            t.start()
            applyDiscovery()
        } catch (e: AdbException) {
            startError = e.message
            log.log(LogLevel.ERROR, e.message ?: "adb unavailable")
        } catch (e: Exception) {
            startError = e.message
            log.log(LogLevel.ERROR, "Failed to start: ${e.message}")
        }
        fire()
    }

    /** Called after settings change. */
    fun settingsChanged(adbPathChanged: Boolean) {
        log.debugEnabled = settings.debugLogging
        if (adbPathChanged) pooled { restart() }
        else {
            connections?.autoReconnect = settings.autoReconnect
            applyDiscovery()
            fire()
        }
    }

    @Synchronized
    private fun applyDiscovery() {
        val b = browser ?: return
        if (settings.autoDiscover && discoverLease == null) discoverLease = b.acquire()
        if (!settings.autoDiscover) { discoverLease?.release(); discoverLease = null }
    }

    @Synchronized
    private fun stopEngine() {
        discoverLease?.release(); discoverLease = null
        connections?.dispose(); browser?.dispose(); tracker?.stop()
        connections = null; browser = null; tracker = null; client = null
    }

    fun entries(): List<DeviceEntry> {
        val t = tracker ?: return emptyList()
        val m = connections ?: return emptyList()
        val b = browser ?: return emptyList()
        return DeviceModel.build(t.devices, m.known, b.services, m::match, settings.preferredDevice.ifEmpty { null })
    }

    fun activity(): Activity = when {
        client == null -> if (startError != null) Activity.NO_ADB else Activity.STARTING
        pairing -> Activity.PAIRING
        connections?.isReconnecting == true -> Activity.RECONNECTING
        searching.get() > 0 -> Activity.SEARCHING
        else -> Activity.IDLE
    }

    /** Hold an mDNS lease while some UI is looking for devices. */
    fun beginSearch(): MdnsBrowser.Lease? {
        val lease = browser?.acquire() ?: return null
        searching.incrementAndGet(); fire()
        val done = AtomicBoolean(false)
        return MdnsBrowser.Lease { if (done.compareAndSet(false, true)) { lease.release(); searching.decrementAndGet(); fire() } }
    }

    fun statusText(): Pair<String, String> {
        val entries = entries()
        val connected = entries.filter { it.status == EntryStatus.CONNECTED }
        val pref = settings.preferredDevice
        val active = connected.firstOrNull { it.id == pref || it.serial == pref } ?: connected.firstOrNull()
        val tip = if (connected.isEmpty()) "No Android device connected"
        else connected.joinToString("\n") { "${it.name} — ${it.endpoint ?: it.serial} (${if (it.transport == Transport.WIFI) "Wi-Fi" else "USB"})" }
        return when (activity()) {
            Activity.NO_ADB -> "ADB: Not found" to "adb was not found. Click to set the adb path."
            Activity.STARTING -> "ADB: Starting..." to "Starting ADB Connect"
            Activity.RECONNECTING -> "ADB: Reconnecting..." to tip
            Activity.PAIRING -> "ADB: Pairing..." to tip
            Activity.SEARCHING -> if (connected.isEmpty()) "ADB: Searching..." to "Looking for Android devices on the network" else statusFor(connected, active, tip)
            Activity.IDLE -> statusFor(connected, active, tip)
        }
    }

    private fun statusFor(connected: List<DeviceEntry>, active: DeviceEntry?, tip: String) = when (connected.size) {
        0 -> "ADB: Disconnected" to tip
        1 -> "ADB: ${active!!.name}" to tip
        else -> "ADB: ${connected.size} Devices Connected" to tip
    }

    fun notify(project: Project?, message: String, type: NotificationType = NotificationType.INFORMATION) {
        NotificationGroupManager.getInstance().getNotificationGroup("ADB Connect").createNotification(message, type).notify(project)
    }

    override fun dispose() {
        stopEngine()
        listeners.clear()
    }

    companion object {
        fun get(): AdbConnectService = service()
        fun pooled(block: () -> Unit) { ApplicationManager.getApplication().executeOnPooledThread(block) }
    }
}
