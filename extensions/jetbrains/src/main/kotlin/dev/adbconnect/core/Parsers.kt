package dev.adbconnect.core

import java.io.ByteArrayOutputStream
import java.net.Inet6Address
import java.net.InetAddress

// Parsers mirror packages/core/src (TypeScript); both are tested against packages/core/fixtures/adb-output.json.

object Endpoints {
    private val ENDPOINT = Regex("""^(\[[0-9a-fA-F:.]+(?:%[A-Za-z0-9_.-]+)?]|[A-Za-z0-9.-]+):(\d{1,5})$""")
    private val HOSTNAME = Regex("""^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$""", RegexOption.IGNORE_CASE)
    private val IPV4 = Regex("""^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$""")

    fun valid(value: String?): Boolean = parse(value) != null

    fun parse(value: String?): Pair<String, Int>? {
        val m = ENDPOINT.matchEntire(value?.trim() ?: return null) ?: return null
        val host = m.groupValues[1]
        val port = m.groupValues[2].toInt()
        if (port !in 1..65535) return null
        if (host.startsWith("[")) {
            val literal = host.substring(1, host.length - 1).substringBefore('%')
            // InetAddress.getByName on a literal containing ':' never does DNS.
            val ok = literal.contains(':') && runCatching { InetAddress.getByName(literal) is Inet6Address }.getOrDefault(false)
            return if (ok) host to port else null
        }
        return if (IPV4.matches(host) || (HOSTNAME.matches(host) && !host.all { it.isDigit() || it == '.' })) host to port else null
    }

    fun validPairingCode(value: String?): Boolean = value != null && Regex("""^\d{6}$""").matches(value)
}

enum class Transport { WIFI, USB }

data class Device(
    val serial: String,
    val state: String,
    val model: String,
    val transport: Transport,
    val endpoint: String? = null,
    val mdnsName: String? = null,
    val attrs: Map<String, String> = emptyMap(),
)

object DeviceParser {
    private const val STATES = "device|offline|unauthorized|authorizing|connecting|recovery|rescue|sideload|bootloader|host|no permissions"
    private val LINE = Regex("""^(\S+)\s+($STATES)(?:\s+(.*))?$""")
    private val MDNS_SERIAL = Regex("""^(adb-[^.\s]+)\._adb-tls-connect\._tcp\.?$""")
    private val ATTR_KEY = Regex("""^[a-z_]+$""")

    fun parseLine(line: String): Device? {
        val m = LINE.matchEntire(line.trim()) ?: return null
        val serial = m.groupValues[1]
        val attrs = linkedMapOf<String, String>()
        for (token in m.groupValues[3].split(Regex("""\s+"""))) {
            val p = token.indexOf(':')
            if (p > 0 && ATTR_KEY.matches(token.substring(0, p))) attrs[token.substring(0, p)] = token.substring(p + 1)
        }
        val mdns = MDNS_SERIAL.matchEntire(serial)?.groupValues?.get(1)
        val endpoint = serial.takeIf { Endpoints.valid(it) }
        return Device(
            serial = serial,
            state = m.groupValues[2],
            model = (attrs["model"] ?: attrs["device"] ?: serial).replace('_', ' '),
            transport = if (endpoint != null || mdns != null) Transport.WIFI else Transport.USB,
            endpoint = endpoint,
            mdnsName = mdns,
            attrs = attrs,
        )
    }

    /** `adb devices -l` (with header) or a track-devices payload (without). */
    fun parse(text: String): List<Device> = text.lines()
        .filter { it.isNotBlank() && !it.startsWith("List of devices", ignoreCase = true) && !it.startsWith("*") }
        .mapNotNull { parseLine(it) }
}

/** Decodes `adb track-devices`: repeated 4-hex-digit length + payload frames, possibly split across reads. */
class TrackDevicesDecoder {
    private val buf = ByteArrayOutputStream()

    fun push(chunk: ByteArray, len: Int = chunk.size): List<String> {
        buf.write(chunk, 0, len)
        val frames = mutableListOf<String>()
        var data = buf.toByteArray()
        var pos = 0
        while (data.size - pos >= 4) {
            val n = String(data, pos, 4, Charsets.US_ASCII).toIntOrNull(16)
            if (n == null) { pos = data.size; break }
            if (data.size - pos - 4 < n) break
            frames += String(data, pos + 4, n, Charsets.UTF_8)
            pos += 4 + n
        }
        buf.reset()
        if (pos < data.size) buf.write(data, pos, data.size - pos)
        data = ByteArray(0)
        return frames
    }
}

enum class ServiceType { CONNECT, PAIRING }

data class MdnsService(val name: String, val type: ServiceType, val endpoint: String) {
    val host: String get() = Endpoints.parse(endpoint)?.first ?: endpoint.substringBeforeLast(':')
}

object MdnsParser {
    private val LINE = Regex("""^(.*?)\s+_adb-tls-(connect|pairing)\._tcp\.?\s+(\S+:\d+)\s*$""")

    fun parse(text: String): List<MdnsService> = text.lines().mapNotNull { line ->
        val m = LINE.matchEntire(line) ?: return@mapNotNull null
        if (!Endpoints.valid(m.groupValues[3])) return@mapNotNull null
        MdnsService(m.groupValues[1].trim(), if (m.groupValues[2] == "connect") ServiceType.CONNECT else ServiceType.PAIRING, m.groupValues[3])
    }
}

data class PairOutcome(val ok: Boolean, val message: String, val endpoint: String? = null, val guid: String? = null)

data class ConnectOutcome(val ok: Boolean, val already: Boolean, val message: String)

object ResultParser {
    private val PAIRED = Regex("""Successfully paired to (\S+)(?:\s+\[guid=([^\]\s]+)])?""", RegexOption.IGNORE_CASE)
    private val FAILED = Regex("failed|cannot|unable|error", RegexOption.IGNORE_CASE)

    fun pair(text: String): PairOutcome {
        val m = PAIRED.find(text) ?: return PairOutcome(false, text.trim().ifEmpty { "adb pair failed" })
        return PairOutcome(true, text.trim(), m.groupValues[1], m.groupValues[2].ifEmpty { null })
    }

    fun connect(text: String): ConnectOutcome {
        val t = text.trim()
        val already = t.contains("already connected to", ignoreCase = true)
        val ok = !FAILED.containsMatchIn(t) && t.contains("connected to", ignoreCase = true)
        return ConnectOutcome(ok, already, t.ifEmpty { "adb connect failed" })
    }
}
