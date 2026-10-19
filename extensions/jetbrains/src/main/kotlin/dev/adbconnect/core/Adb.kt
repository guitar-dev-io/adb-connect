package dev.adbconnect.core

import java.io.File
import java.io.InputStream
import java.util.concurrent.Semaphore
import java.util.concurrent.TimeUnit

enum class LogLevel { DEBUG, INFO, WARN, ERROR }

fun interface AdbLog {
    fun log(level: LogLevel, message: String)
}

data class AdbResult(val code: Int, val stdout: String, val stderr: String) {
    /** adb prints many failures to stdout with exit code 0, so callers usually inspect both. */
    val text: String get() = "$stdout\n$stderr".trim()
}

class AdbException(message: String, val kind: Kind) : Exception(message) {
    enum class Kind { NOT_FOUND, TIMEOUT, CANCELLED, SPAWN, VERSION }
}

fun redact(text: String, secrets: Collection<String>): String =
    secrets.filter { it.isNotEmpty() }.fold(text) { acc, s -> acc.replace(s, "[REDACTED]") }

/** Render adb args for logs, hiding the pairing secret (`adb pair <endpoint> <secret>`). */
fun describeArgs(args: List<String>): String =
    args.mapIndexed { i, a -> if (args.firstOrNull() == "pair" && i == 2) "[REDACTED]" else a }.joinToString(" ")

/**
 * Runs adb without a shell, with timeouts, cancellation, bounded output and bounded concurrency.
 * Never restarts the adb server. Blocking: call from a background thread.
 */
class AdbRunner(val adbPath: String, private val log: AdbLog = AdbLog { _, _ -> }, maxConcurrent: Int = 4) {
    private val limiter = Semaphore(maxConcurrent, true)

    fun run(
        args: List<String>,
        timeoutMs: Long = 12_000,
        secrets: List<String> = emptyList(),
        cancelled: () -> Boolean = { false },
    ): AdbResult {
        limiter.acquire()
        val started = System.currentTimeMillis()
        try {
            val r = exec(args, timeoutMs, secrets, cancelled)
            log.log(LogLevel.DEBUG, "adb ${describeArgs(args)} exit=${r.code} ${System.currentTimeMillis() - started}ms")
            return r
        } catch (e: AdbException) {
            log.log(LogLevel.DEBUG, "adb ${describeArgs(args)} failed: ${e.message}")
            throw e
        } finally {
            limiter.release()
        }
    }

    /** Long-lived process (track-devices). Caller owns its lifetime. */
    fun startStream(args: List<String>): Process {
        log.log(LogLevel.DEBUG, "adb ${describeArgs(args)} (stream)")
        return try {
            ProcessBuilder(listOf(adbPath) + args).redirectInput(ProcessBuilder.Redirect.from(nullFile())).start()
        } catch (e: Exception) {
            throw AdbException("Cannot run adb ($adbPath): ${e.message}", AdbException.Kind.SPAWN)
        }
    }

    private fun exec(args: List<String>, timeoutMs: Long, secrets: List<String>, cancelled: () -> Boolean): AdbResult {
        if (cancelled()) throw AdbException("adb command cancelled", AdbException.Kind.CANCELLED)
        val proc = try {
            ProcessBuilder(listOf(adbPath) + args).redirectInput(ProcessBuilder.Redirect.from(nullFile())).start()
        } catch (e: Exception) {
            val kind = if (!File(adbPath).exists() && adbPath.contains(File.separatorChar)) AdbException.Kind.NOT_FOUND else AdbException.Kind.SPAWN
            throw AdbException("Cannot run adb ($adbPath): ${e.message}", kind)
        }
        val out = StreamCollector(proc.inputStream).also { it.start() }
        val err = StreamCollector(proc.errorStream).also { it.start() }
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!proc.waitFor(50, TimeUnit.MILLISECONDS)) {
            if (cancelled()) {
                proc.destroyForcibly()
                throw AdbException("adb command cancelled", AdbException.Kind.CANCELLED)
            }
            if (System.currentTimeMillis() > deadline) {
                proc.destroyForcibly()
                throw AdbException("adb ${args.firstOrNull() ?: ""} timed out after $timeoutMs ms", AdbException.Kind.TIMEOUT)
            }
        }
        out.join(1000)
        err.join(1000)
        return AdbResult(proc.exitValue(), redact(out.text(), secrets), redact(err.text(), secrets))
    }

    private class StreamCollector(private val input: InputStream) : Thread("adb-output") {
        private val sb = StringBuilder()
        init { isDaemon = true }
        override fun run() {
            input.bufferedReader().use { r ->
                val buf = CharArray(4096)
                while (true) {
                    val n = r.read(buf)
                    if (n < 0) break
                    synchronized(sb) {
                        sb.append(buf, 0, n)
                        if (sb.length > MAX_OUTPUT) sb.delete(0, sb.length - MAX_OUTPUT)
                    }
                }
            }
        }
        fun text(): String = synchronized(sb) { sb.toString() }
    }

    companion object {
        private const val MAX_OUTPUT = 100_000
        private fun nullFile() = File(if (System.getProperty("os.name").lowercase().contains("win")) "NUL" else "/dev/null")
    }
}

data class AdbLocation(val path: String, val source: String)

object AdbLocator {
    /** Candidate locations in priority order. Pure (no filesystem access). */
    fun candidates(configured: String?, env: Map<String, String>, windows: Boolean, home: String): List<AdbLocation> {
        val sep = if (windows) "\\" else "/"
        val exe = if (windows) "adb.exe" else "adb"
        fun join(vararg parts: String) = parts.joinToString(sep) { it.trimEnd('/', '\\') }
        val out = mutableListOf<AdbLocation>()
        val c = configured?.trim().orEmpty()
        if (c.isNotEmpty() && c != "adb" && c != "adb.exe") out += AdbLocation(c, "setting")
        for (key in listOf("ANDROID_HOME", "ANDROID_SDK_ROOT")) env[key]?.takeIf { it.isNotBlank() }?.let { out += AdbLocation(join(it, "platform-tools", exe), key) }
        val path = env["PATH"] ?: env["Path"] ?: ""
        for (dir in path.split(if (windows) ';' else ':')) if (dir.isNotBlank()) out += AdbLocation(join(dir, exe), "PATH")
        val sdk = when {
            windows -> join(env["LOCALAPPDATA"] ?: join(home, "AppData", "Local"), "Android", "Sdk")
            System.getProperty("os.name").lowercase().contains("mac") -> join(home, "Library", "Android", "sdk")
            else -> join(home, "Android", "Sdk")
        }
        out += AdbLocation(join(sdk, "platform-tools", exe), "default-sdk")
        return out
    }

    /** A configured path that does not exist is reported as missing rather than silently replaced. */
    fun locate(configured: String?): AdbLocation? {
        val windows = System.getProperty("os.name").lowercase().contains("win")
        val list = candidates(configured, System.getenv(), windows, System.getProperty("user.home"))
        val usable = { l: AdbLocation -> File(l.path).let { it.isFile && (windows || it.canExecute()) } }
        if (list.firstOrNull()?.source == "setting") return list.first().takeIf(usable)
        return list.firstOrNull(usable)
    }
}

data class AdbVersion(val adb: String, val platformTools: String?) {
    val wirelessPairing: Boolean get() = platformTools != null && compareVersions(platformTools, MIN_PLATFORM_TOOLS) >= 0

    companion object {
        /** `adb pair` landed in platform-tools 30; reliable `adb mdns services` in 31. */
        const val MIN_PLATFORM_TOOLS = "31.0.0"

        fun parse(text: String): AdbVersion? {
            val adb = Regex("""Android Debug Bridge version (\d+\.\d+\.\d+)""", RegexOption.IGNORE_CASE).find(text) ?: return null
            val pt = Regex("""^Version (\d+\.\d+\.\d+)""", RegexOption.MULTILINE).find(text)
            return AdbVersion(adb.groupValues[1], pt?.groupValues?.get(1))
        }

        fun compareVersions(a: String, b: String): Int {
            val pa = a.split('.').map { it.toIntOrNull() ?: 0 }
            val pb = b.split('.').map { it.toIntOrNull() ?: 0 }
            for (i in 0 until maxOf(pa.size, pb.size)) {
                val d = (pa.getOrElse(i) { 0 }) - (pb.getOrElse(i) { 0 })
                if (d != 0) return Integer.signum(d)
            }
            return 0
        }
    }
}
