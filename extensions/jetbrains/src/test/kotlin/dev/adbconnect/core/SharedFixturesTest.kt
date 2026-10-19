package dev.adbconnect.core

import com.google.gson.JsonArray
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.google.zxing.BinaryBitmap
import com.google.zxing.RGBLuminanceSource
import com.google.zxing.common.HybridBinarizer
import com.google.zxing.qrcode.QRCodeReader
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Same vectors as packages/core/test/parsers.test.ts, so Kotlin and TypeScript parse adb identically. */
class SharedFixturesTest {
    private val fx: JsonObject = JsonParser.parseString(
        File(System.getProperty("adbconnect.fixtures") ?: "../../packages/core/fixtures/adb-output.json").readText(),
    ).asJsonObject

    private fun JsonObject.str(k: String) = get(k)?.takeUnless { it.isJsonNull }?.asString

    @Test fun devices() {
        for (c in fx.getAsJsonArray("devices").map { it.asJsonObject }) {
            val got = DeviceParser.parse(c.str("input")!!)
            val exp = c.getAsJsonArray("expected").map { it.asJsonObject }
            assertEquals(c.str("name"), exp.size, got.size)
            exp.zip(got).forEach { (e, d) ->
                assertEquals(e.str("serial"), d.serial)
                assertEquals(e.str("state"), d.state)
                assertEquals(e.str("model"), d.model)
                assertEquals(e.str("transport"), d.transport.name.lowercase())
                assertEquals(e.str("endpoint"), d.endpoint)
                assertEquals(e.str("mdnsName"), d.mdnsName)
            }
        }
    }

    @Test fun trackDevicesFramesSplitAtEveryByte() {
        for (c in fx.getAsJsonArray("trackDevicesFrames").map { it.asJsonObject }) {
            val dec = TrackDevicesDecoder()
            val frames = c.str("input")!!.toByteArray().flatMap { dec.push(byteArrayOf(it)) }
            assertEquals(c.get("expectedFrames").asInt, frames.size)
            assertEquals(c.getAsJsonArray("expectedDeviceCounts").map { it.asInt }, frames.map { DeviceParser.parse(it).size })
        }
    }

    @Test fun mdns() {
        for (c in fx.getAsJsonArray("mdns").map { it.asJsonObject }) {
            val got = MdnsParser.parse(c.str("input")!!)
            val exp = c.getAsJsonArray("expected").map { it.asJsonObject }
            assertEquals(exp.map { Triple(it.str("name"), it.str("type"), it.str("endpoint")) }, got.map { Triple(it.name, it.type.name.lowercase(), it.endpoint) })
        }
    }

    @Test fun pairAndConnectOutput() {
        for (c in fx.getAsJsonArray("pair").map { it.asJsonObject }) {
            val e = c.getAsJsonObject("expected")
            val r = ResultParser.pair(c.str("input")!!)
            assertEquals(e.get("ok").asBoolean, r.ok)
            assertEquals(e.str("endpoint"), r.endpoint)
            assertEquals(e.str("guid"), r.guid)
        }
        for (c in fx.getAsJsonArray("connect").map { it.asJsonObject }) {
            val e = c.getAsJsonObject("expected")
            val r = ResultParser.connect(c.str("input")!!)
            assertEquals(c.str("input"), e.get("ok").asBoolean, r.ok)
            assertEquals(e.get("already").asBoolean, r.already)
        }
    }

    @Test fun version() {
        for (c in fx.getAsJsonArray("version").map { it.asJsonObject }) {
            val e = c.getAsJsonObject("expected")
            val v = AdbVersion.parse(c.str("input")!!)!!
            assertEquals(e.str("adb"), v.adb)
            assertEquals(e.str("platformTools"), v.platformTools)
            assertEquals(e.get("wirelessPairing").asBoolean, v.wirelessPairing)
        }
        assertNull(AdbVersion.parse("garbage"))
    }

    @Test fun endpoints() {
        val ep = fx.getAsJsonObject("endpoints")
        (ep.get("valid") as JsonArray).forEach { assertTrue(it.asString, Endpoints.valid(it.asString)) }
        (ep.get("invalid") as JsonArray).forEach { assertFalse(it.asString, Endpoints.valid(it.asString)) }
        assertTrue(Endpoints.validPairingCode("123456"))
        listOf("12345", "1234567", "12345a", "").forEach { assertFalse(Endpoints.validPairingCode(it)) }
    }

    @Test fun qrPayloadAndRoundTrip() {
        val q = fx.getAsJsonObject("qr")
        val creds = q.getAsJsonObject("credentials")
        assertEquals(q.str("payload"), QrCredentials(creds.str("serviceName")!!, creds.str("password")!!).payload)

        val a = QrCredentials.create()
        assertNotEquals(a.password, QrCredentials.create().password)
        assertTrue(Regex("^WIFI:T:ADB;S:adbconnect-[a-z0-9]{10};P:[A-Za-z0-9]{12};;$").matches(a.payload))

        // Encode, rasterise, decode: the image a phone scans carries exactly the payload.
        val m = QrEncoder.matrix(a.payload, 300)
        val px = IntArray(m.width * m.height) { i -> if (m.get(i % m.width, i / m.width)) 0xFF000000.toInt() else 0xFFFFFFFF.toInt() }
        val decoded = QRCodeReader().decode(BinaryBitmap(HybridBinarizer(RGBLuminanceSource(m.width, m.height, px)))).text
        assertEquals(a.payload, decoded)
    }

    @Test fun secretsRedacted() {
        assertEquals("code [REDACTED]", redact("code 654321", listOf("654321")))
        assertEquals("pair 1.2.3.4:5 [REDACTED]", describeArgs(listOf("pair", "1.2.3.4:5", "654321")))
    }

    @Test fun locatorOrder() {
        val c = AdbLocator.candidates("/custom/adb", mapOf("ANDROID_HOME" to "/sdk", "PATH" to "/usr/bin:/opt/bin"), windows = false, home = "/home/u")
        assertEquals(listOf("/custom/adb", "/sdk/platform-tools/adb", "/usr/bin/adb", "/opt/bin/adb"), c.dropLast(1).map { it.path })
        assertEquals("setting", c.first().source)
        assertEquals("default-sdk", AdbLocator.candidates("adb", emptyMap(), false, "/h").single().source)
    }

    @Test fun modelMergesLiveKnownAndAdvertised() {
        val guid = "adb-SERIAL1-abc"
        val known = KnownDevice(guid, "Pixel 9 Pro", guid = guid, lastEndpoint = "192.168.1.10:37123")
        val entries = DeviceModel.build(
            listOf(Device("USB123", "device", "Galaxy S24", Transport.USB)),
            listOf(known),
            listOf(MdnsService(guid, ServiceType.CONNECT, "192.168.1.10:40000"), MdnsService("adb-OTHER-1", ServiceType.CONNECT, "192.168.1.60:40000")),
            { null }, guid,
        )
        assertEquals(listOf("Pixel 9 Pro", "Galaxy S24", "adb-OTHER-1"), entries.map { it.name })
        assertEquals(EntryStatus.AVAILABLE, entries[0].status)
        assertEquals("192.168.1.10:40000", entries[0].endpoint)
        assertTrue(entries[0].preferred)
        assertFalse(entries[2].known)
        assertTrue(entries[1].adbCommands().any { it.second == "adb -s USB123 shell" })
    }
}
