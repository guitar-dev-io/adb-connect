package dev.adbconnect.core

import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

data class OpResult(val ok: Boolean, val message: String)

data class AdbInfo(val location: AdbLocation, val version: AdbVersion)

/** Typed wrapper around the adb CLI. All pairing crypto is done by adb itself. Blocking calls. */
class AdbClient(val runner: AdbRunner, val info: AdbInfo) {

    fun devices(cancelled: () -> Boolean = { false }): List<Device> {
        val r = runner.run(listOf("devices", "-l"), 8_000, cancelled = cancelled)
        if (r.code != 0) throw IllegalStateException(r.text.ifEmpty { "adb devices failed" })
        return DeviceParser.parse(r.stdout)
    }

    fun mdnsServices(cancelled: () -> Boolean = { false }): List<MdnsService> {
        val r = runner.run(listOf("mdns", "services"), 6_000, cancelled = cancelled)
        if (r.code != 0) throw IllegalStateException(r.text.ifEmpty { "adb mdns services failed" })
        return MdnsParser.parse(r.stdout)
    }

    fun mdnsAvailable(): Boolean = runCatching {
        val r = runner.run(listOf("mdns", "check"), 5_000)
        r.code == 0 && !Regex("error|unavailable", RegexOption.IGNORE_CASE).containsMatchIn(r.text)
    }.getOrDefault(false)

    /** `secret` is a 6-digit code or QR password; it is redacted from logs and output. */
    fun pair(endpoint: String, secret: String, cancelled: () -> Boolean = { false }): PairOutcome {
        if (!info.version.wirelessPairing) return PairOutcome(false, "Wireless pairing needs Android SDK Platform-Tools ${AdbVersion.MIN_PLATFORM_TOOLS} or newer")
        if (!Endpoints.valid(endpoint)) return PairOutcome(false, "Invalid pairing host:port")
        if (secret.isEmpty() || secret.any { it.isWhitespace() || it == ';' }) return PairOutcome(false, "Invalid pairing secret")
        val r = runner.run(listOf("pair", endpoint, secret), 30_000, listOf(secret), cancelled)
        return ResultParser.pair(r.text)
    }

    fun pairWithCode(endpoint: String, code: String, cancelled: () -> Boolean = { false }): PairOutcome =
        if (!Endpoints.validPairingCode(code)) PairOutcome(false, "Pairing code must be exactly 6 digits") else pair(endpoint, code, cancelled)

    fun connect(endpoint: String, timeoutMs: Long = 15_000, cancelled: () -> Boolean = { false }): ConnectOutcome {
        if (!Endpoints.valid(endpoint)) return ConnectOutcome(false, false, "Invalid host:port")
        return ResultParser.connect(runner.run(listOf("connect", endpoint), timeoutMs, cancelled = cancelled).text)
    }

    /** Never called without a serial (that would drop every wireless device). */
    fun disconnect(serial: String): OpResult {
        if (serial.isEmpty() || serial.startsWith("-") || serial.any { it.isWhitespace() }) return OpResult(false, "Invalid device serial")
        val r = runner.run(listOf("disconnect", serial), 10_000)
        val ok = r.code == 0 && !Regex("error|no such device", RegexOption.IGNORE_CASE).containsMatchIn(r.text)
        return OpResult(ok, r.text.ifEmpty { "adb disconnect failed" })
    }

    fun getProp(serial: String, prop: String): String? {
        require(Regex("^[a-z0-9._]+$", RegexOption.IGNORE_CASE).matches(prop))
        val r = runner.run(listOf("-s", serial, "shell", "getprop", prop), 6_000)
        return r.stdout.trim().takeIf { r.code == 0 && it.isNotEmpty() }
    }

    companion object {
        fun create(configuredPath: String?, log: AdbLog): AdbClient {
            val location = AdbLocator.locate(configuredPath) ?: throw AdbException(
                if (!configuredPath.isNullOrBlank() && configuredPath != "adb") "adb not found at configured path: $configuredPath"
                else "adb not found. Install Android SDK Platform-Tools or set the adb path.",
                AdbException.Kind.NOT_FOUND,
            )
            val runner = AdbRunner(location.path, log)
            val version = AdbVersion.parse(runner.run(listOf("version"), 5_000).text)
                ?: throw AdbException("Unrecognised adb version output from ${location.path}", AdbException.Kind.VERSION)
            return AdbClient(runner, AdbInfo(location, version))
        }
    }
}

/**
 * Event-driven device list via one long-lived `adb track-devices -l`. Re-attaches with capped
 * backoff when the stream ends (adb server restarted elsewhere); never kills the server itself.
 */
class DeviceTracker(private val runner: AdbRunner, private val log: AdbLog, private val minBackoffMs: Long = 1_000, private val maxBackoffMs: Long = 30_000) {
    private val listeners = CopyOnWriteArrayList<(List<Device>) -> Unit>()
    private val running = AtomicBoolean(false)
    @Volatile private var process: Process? = null
    @Volatile private var thread: Thread? = null
    @Volatile var devices: List<Device> = emptyList(); private set

    fun addListener(l: (List<Device>) -> Unit) { listeners += l }
    fun removeListener(l: (List<Device>) -> Unit) { listeners -= l }

    fun start() {
        if (!running.compareAndSet(false, true)) return
        thread = Thread(::loop, "adb-connect-track-devices").apply { isDaemon = true; start() }
    }

    fun stop() {
        running.set(false)
        process?.destroy()
        thread?.interrupt()
    }

    private fun publish(list: List<Device>) {
        devices = list
        listeners.forEach { runCatching { it(list) } }
    }

    private fun loop() {
        var backoff = minBackoffMs
        while (running.get()) {
            try {
                val p = runner.startStream(listOf("track-devices", "-l"))
                process = p
                val decoder = TrackDevicesDecoder()
                val buf = ByteArray(8192)
                val input = p.inputStream
                while (running.get()) {
                    val n = input.read(buf)
                    if (n < 0) break
                    for (frame in decoder.push(buf, n)) {
                        backoff = minBackoffMs
                        publish(DeviceParser.parse(frame))
                    }
                }
                p.destroy()
            } catch (e: Exception) {
                if (!running.get()) break
                log.log(LogLevel.WARN, "Device tracking failed: ${e.message}")
            }
            if (!running.get()) break
            publish(emptyList())
            log.log(LogLevel.WARN, "Device tracking interrupted; re-attaching in ${backoff}ms")
            try { Thread.sleep(backoff) } catch (_: InterruptedException) { break }
            backoff = minOf(backoff * 2, maxBackoffMs)
        }
    }
}

/**
 * Watches `_adb-tls-pairing._tcp` / `_adb-tls-connect._tcp` through the adb server. adb has no mDNS
 * event stream, so this polls — only while a lease is held, never overlapping, with backoff on errors.
 */
class MdnsBrowser(private val client: AdbClient, private val log: AdbLog, private val intervalMs: Long = 3_000, private val maxIntervalMs: Long = 60_000) {
    fun interface Lease { fun release() }

    private val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "adb-connect-mdns").apply { isDaemon = true } }
    private val leases = AtomicInteger()
    private val listeners = CopyOnWriteArrayList<(List<MdnsService>, List<MdnsService>) -> Unit>()
    private var task: ScheduledFuture<*>? = null
    private var failures = 0
    private val pollLock = Any()
    @Volatile var services: List<MdnsService> = emptyList(); private set
    val active: Boolean get() = leases.get() > 0

    /** Listener receives (all services, newly added services). */
    fun addListener(l: (List<MdnsService>, List<MdnsService>) -> Unit) { listeners += l }
    fun removeListener(l: (List<MdnsService>, List<MdnsService>) -> Unit) { listeners -= l }

    fun acquire(): Lease {
        if (leases.incrementAndGet() == 1) schedule(0)
        val released = AtomicBoolean(false)
        return Lease {
            if (released.compareAndSet(false, true) && leases.decrementAndGet() == 0) synchronized(this) { task?.cancel(false); task = null }
        }
    }

    /** Poll once now; concurrent callers share the lock so adb is not invoked in parallel. */
    fun refresh(): List<MdnsService> {
        poll()
        return services
    }

    /** Block until a service matching [predicate] shows up. Throws TimeoutException / InterruptedException. */
    fun waitFor(timeoutMs: Long, cancelled: () -> Boolean, predicate: (MdnsService) -> Boolean): MdnsService {
        services.firstOrNull(predicate)?.let { return it }
        val lease = acquire()
        try {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (true) {
                services.firstOrNull(predicate)?.let { return it }
                if (cancelled()) throw InterruptedException("cancelled")
                if (System.currentTimeMillis() > deadline) throw TimeoutException("timeout")
                Thread.sleep(100)
            }
        } finally {
            lease.release()
        }
    }

    fun dispose() {
        leases.set(0)
        task?.cancel(false)
        scheduler.shutdownNow()
        listeners.clear()
    }

    @Synchronized
    private fun schedule(delayMs: Long) {
        if (scheduler.isShutdown) return
        task = scheduler.schedule({
            poll()
            if (leases.get() > 0) {
                val backoff = minOf(intervalMs * (1L shl minOf(failures, 6)), maxIntervalMs)
                schedule(if (failures > 0) backoff else intervalMs)
            }
        }, delayMs, TimeUnit.MILLISECONDS)
    }

    private fun poll() = synchronized(pollLock) {
        try {
            val next = client.mdnsServices()
            failures = 0
            val added = next.filter { it !in services }
            services = next // update first so listeners see the new state
            listeners.forEach { runCatching { it(next, added) } }
        } catch (e: Exception) {
            failures++
            log.log(LogLevel.WARN, "mDNS discovery failed (#$failures): ${e.message}")
        }
    }
}
