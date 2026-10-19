package dev.adbconnect.core

import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.common.BitMatrix
import com.google.zxing.qrcode.QRCodeWriter
import com.google.zxing.qrcode.decoder.ErrorCorrectionLevel
import java.security.SecureRandom
import java.util.concurrent.TimeoutException
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android Wireless Debugging QR pairing (Android 11+), as used by Android Studio:
 *  1. Show a QR encoding  WIFI:T:ADB;S:<serviceName>;P:<password>;;
 *  2. The phone scans it and advertises `_adb-tls-pairing._tcp` with instance name <serviceName>.
 *  3. Find it through the adb server's mDNS and run `adb pair <ip:port> <password>`.
 *  4. Connect to the `_adb-tls-connect._tcp` service named after the device GUID.
 */
data class QrCredentials(val serviceName: String, val password: String) {
    val payload: String
        get() {
            require(Regex("^[A-Za-z0-9-]+$").matches(serviceName) && Regex("^[A-Za-z0-9]+$").matches(password)) { "QR credentials need escaping" }
            return "WIFI:T:ADB;S:$serviceName;P:$password;;"
        }

    companion object {
        private val random = SecureRandom()
        private const val LOWER = "abcdefghijklmnopqrstuvwxyz0123456789"
        private const val ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
        private fun rnd(alphabet: String, n: Int) = buildString { repeat(n) { append(alphabet[random.nextInt(alphabet.length)]) } }

        fun create() = QrCredentials("adbconnect-${rnd(LOWER, 10)}", rnd(ALNUM, 12))
    }
}

object QrEncoder {
    fun matrix(payload: String, size: Int = 1): BitMatrix =
        QRCodeWriter().encode(payload, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.ERROR_CORRECTION to ErrorCorrectionLevel.M, EncodeHintType.MARGIN to 2))
}

enum class PairingState { WAITING_FOR_SCAN, PAIRING, CONNECTING, CONNECTED, PAIRED, FAILED, TIMEOUT, CANCELLED;
    val isFinal: Boolean get() = this in setOf(CONNECTED, PAIRED, FAILED, TIMEOUT, CANCELLED)
}

data class PairingUpdate(
    val state: PairingState,
    val message: String,
    val guid: String? = null,
    val endpoint: String? = null,
    val device: Device? = null,
)

object Pairing {
    /** After `adb pair`, find the connect service and make sure a transport exists (adb often auto-connects). */
    fun connectAfterPair(
        client: AdbClient, browser: MdnsBrowser, guid: String?, pairEndpoint: String,
        connectTimeoutMs: Long, cancelled: () -> Boolean, onUpdate: (PairingUpdate) -> Unit,
    ): PairingUpdate {
        onUpdate(PairingUpdate(PairingState.CONNECTING, "Paired. Connecting…", guid))
        val pairHost = Endpoints.parse(pairEndpoint)?.first
        val service = try {
            browser.waitFor(connectTimeoutMs, cancelled) { it.type == ServiceType.CONNECT && (if (guid != null) it.name == guid else it.host == pairHost) }
        } catch (_: InterruptedException) {
            return PairingUpdate(PairingState.CANCELLED, "Cancelled after pairing", guid)
        } catch (_: TimeoutException) {
            return PairingUpdate(PairingState.PAIRED, "Paired, but the device did not advertise a connect address. Use \"Connect Device\" with the IP address & Port shown under Wireless debugging.", guid)
        }
        fun find(list: List<Device>) = list.firstOrNull { it.state == "device" && ((guid != null && it.mdnsName == guid) || it.endpoint == service.endpoint) }
        var device = find(runCatching { client.devices(cancelled) }.getOrDefault(emptyList()))
        if (device == null) {
            val r = client.connect(service.endpoint, cancelled = cancelled)
            if (!r.ok) return PairingUpdate(PairingState.PAIRED, "Paired, but connecting failed: ${r.message}", guid, service.endpoint)
            device = find(runCatching { client.devices(cancelled) }.getOrDefault(emptyList()))
        }
        return PairingUpdate(PairingState.CONNECTED, "Connected to ${device?.model ?: service.endpoint}", guid, service.endpoint, device)
    }

    fun pairWithCode(
        client: AdbClient, browser: MdnsBrowser, endpoint: String, code: String,
        cancelled: () -> Boolean = { false }, onUpdate: (PairingUpdate) -> Unit = {},
    ): PairingUpdate {
        onUpdate(PairingUpdate(PairingState.PAIRING, "Pairing with $endpoint…"))
        return try {
            val r = client.pairWithCode(endpoint, code, cancelled)
            if (!r.ok) PairingUpdate(PairingState.FAILED, r.message)
            else connectAfterPair(client, browser, r.guid, endpoint, 20_000, cancelled, onUpdate)
        } catch (e: AdbException) {
            if (e.kind == AdbException.Kind.CANCELLED) PairingUpdate(PairingState.CANCELLED, "Pairing cancelled") else PairingUpdate(PairingState.FAILED, e.message ?: "Pairing failed")
        }
    }
}

/** One QR pairing attempt with single-use, in-memory credentials. [run] blocks; call [cancel] from any thread. */
class QrPairingSession(
    private val client: AdbClient,
    private val browser: MdnsBrowser,
    private val scanTimeoutMs: Long = 120_000,
    private val connectTimeoutMs: Long = 20_000,
    val credentials: QrCredentials = QrCredentials.create(),
) {
    private val cancelledFlag = AtomicBoolean(false)
    val payload: String get() = credentials.payload

    fun cancel() = cancelledFlag.set(true)

    fun run(onUpdate: (PairingUpdate) -> Unit): PairingUpdate {
        val cancelled = { cancelledFlag.get() }
        fun finish(u: PairingUpdate) = u.also(onUpdate)
        if (!client.info.version.wirelessPairing) return finish(PairingUpdate(PairingState.FAILED, "QR pairing needs Android SDK Platform-Tools 31 or newer."))
        if (!client.mdnsAvailable()) return finish(PairingUpdate(PairingState.FAILED, "The adb server mDNS backend is unavailable, so QR pairing cannot discover the phone. Use the pairing code instead."))

        onUpdate(PairingUpdate(PairingState.WAITING_FOR_SCAN, "Scan the QR code from Wireless debugging › Pair device with QR code"))
        val service = try {
            browser.waitFor(scanTimeoutMs, cancelled) { it.type == ServiceType.PAIRING && it.name == credentials.serviceName }
        } catch (_: TimeoutException) {
            return finish(PairingUpdate(PairingState.TIMEOUT, "No phone scanned the QR code in time."))
        } catch (_: InterruptedException) {
            return finish(PairingUpdate(PairingState.CANCELLED, "QR pairing cancelled"))
        }
        onUpdate(PairingUpdate(PairingState.PAIRING, "Pairing with ${service.endpoint}…", endpoint = service.endpoint))
        return try {
            val r = client.pair(service.endpoint, credentials.password, cancelled)
            if (!r.ok) finish(PairingUpdate(PairingState.FAILED, r.message))
            else finish(Pairing.connectAfterPair(client, browser, r.guid, service.endpoint, connectTimeoutMs, cancelled, onUpdate))
        } catch (e: AdbException) {
            finish(if (e.kind == AdbException.Kind.CANCELLED) PairingUpdate(PairingState.CANCELLED, "QR pairing cancelled") else PairingUpdate(PairingState.FAILED, e.message ?: "Pairing failed"))
        }
    }
}
