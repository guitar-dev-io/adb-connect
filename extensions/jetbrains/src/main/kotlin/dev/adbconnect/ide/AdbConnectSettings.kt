package dev.adbconnect.ide

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.RoamingType
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.util.xmlb.annotations.XCollection
import dev.adbconnect.core.KnownDevice
import dev.adbconnect.core.KnownDeviceStore

/** XML-serialisable form of [KnownDevice]. Contains no secrets (adb keeps pairing keys in ~/.android). */
class KnownDeviceBean {
    var id: String = ""
    var name: String = ""
    var guid: String? = null
    var serialNo: String? = null
    var lastEndpoint: String? = null
    var pairedAt: Long = 0
    var lastConnectedAt: Long = 0
    var autoReconnect: Boolean = true
    var userDisconnected: Boolean = false

    fun toModel() = KnownDevice(id, name.ifEmpty { id }, guid, serialNo, lastEndpoint, pairedAt.takeIf { it > 0 }, lastConnectedAt.takeIf { it > 0 }, autoReconnect, userDisconnected)

    companion object {
        fun of(k: KnownDevice) = KnownDeviceBean().apply {
            id = k.id; name = k.name; guid = k.guid; serialNo = k.serialNo; lastEndpoint = k.lastEndpoint
            pairedAt = k.pairedAt ?: 0; lastConnectedAt = k.lastConnectedAt ?: 0; autoReconnect = k.autoReconnect; userDisconnected = k.userDisconnected
        }
    }
}

/** Application-level settings, stored per machine (not roamed: devices and adb paths are machine-specific). */
@Service(Service.Level.APP)
@State(name = "AdbConnectSettings", storages = [Storage(value = "adbConnect.xml", roamingType = RoamingType.DISABLED)])
class AdbConnectSettings : PersistentStateComponent<AdbConnectSettings.Data>, KnownDeviceStore {
    class Data {
        var adbPath: String = ""
        var autoDiscover: Boolean = true
        var autoReconnect: Boolean = true
        var reconnectOnStartup: Boolean = true
        var showStatusBar: Boolean = true
        var preferredDevice: String = ""
        var debugLogging: Boolean = false

        @XCollection(style = XCollection.Style.v2)
        var knownDevices: MutableList<KnownDeviceBean> = mutableListOf()
    }

    private var data = Data()

    override fun getState(): Data = data
    override fun loadState(state: Data) { data = state }

    var adbPath: String get() = data.adbPath; set(v) { data.adbPath = v }
    var autoDiscover: Boolean get() = data.autoDiscover; set(v) { data.autoDiscover = v }
    var autoReconnect: Boolean get() = data.autoReconnect; set(v) { data.autoReconnect = v }
    var reconnectOnStartup: Boolean get() = data.reconnectOnStartup; set(v) { data.reconnectOnStartup = v }
    var showStatusBar: Boolean get() = data.showStatusBar; set(v) { data.showStatusBar = v }
    var preferredDevice: String get() = data.preferredDevice; set(v) { data.preferredDevice = v }
    var debugLogging: Boolean get() = data.debugLogging; set(v) { data.debugLogging = v }

    override fun load(): List<KnownDevice> = data.knownDevices.filter { it.id.isNotEmpty() }.map { it.toModel() }

    override fun save(devices: List<KnownDevice>) {
        data.knownDevices = devices.map(KnownDeviceBean::of).toMutableList()
    }

    companion object {
        fun get(): AdbConnectSettings = service()
    }
}
