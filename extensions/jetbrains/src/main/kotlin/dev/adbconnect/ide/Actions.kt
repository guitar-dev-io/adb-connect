package dev.adbconnect.ide

import com.intellij.icons.AllIcons
import com.intellij.ide.DataManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.actionSystem.Separator
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.InputValidator
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.popup.JBPopupFactory
import com.intellij.openapi.ui.popup.PopupStep
import com.intellij.openapi.ui.popup.util.BaseListPopupStep
import com.intellij.openapi.wm.ToolWindowManager
import dev.adbconnect.core.DeviceEntry
import dev.adbconnect.core.EntryStatus
import dev.adbconnect.core.Endpoints
import dev.adbconnect.core.ReconnectReason
import dev.adbconnect.core.Transport
import java.awt.Component
import java.awt.datatransfer.StringSelection
import javax.swing.Icon

/** UI flows shared by actions, the status bar popup and the tool window. */
object AdbUi {
    private val svc get() = AdbConnectService.get()
    private val settings get() = AdbConnectSettings.get()

    /** Returns false (and tells the user how to fix it) when adb is unavailable. */
    fun requireAdb(project: Project?): Boolean {
        if (svc.client != null) return true
        val choice = Messages.showDialog(project, "ADB Connect: ${svc.startError ?: "adb is not available."}", "ADB Not Found",
            arrayOf("Set adb Path…", "Retry", "Cancel"), 0, Messages.getWarningIcon())
        when (choice) {
            0 -> chooseAdbPath(project)
            1 -> AdbConnectService.pooled { svc.restart() }
        }
        return false
    }

    fun chooseAdbPath(project: Project?) {
        val file = FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle("Select the adb Executable"), project, null) ?: return
        settings.adbPath = file.path
        svc.settingsChanged(adbPathChanged = true)
    }

    private fun background(project: Project?, title: String, cancellable: Boolean = false, work: (ProgressIndicator) -> Unit) {
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, cancellable) {
            override fun run(indicator: ProgressIndicator) = work(indicator)
        })
    }

    private fun fail(project: Project?, title: String, message: String) {
        svc.log.log(dev.adbconnect.core.LogLevel.WARN, "$title: $message")
        svc.notify(project, "$title: ${message.lineSequence().first().take(300)}", NotificationType.ERROR)
    }

    fun connectEndpoint(project: Project?, endpoint: String, name: String? = null) {
        val m = svc.connections ?: return
        background(project, "Connecting to $endpoint") {
            val r = m.connectEndpoint(endpoint, name)
            if (r.ok) svc.notify(project, "Connected to ${r.device?.name ?: endpoint}") else fail(project, "Connect failed", r.message)
        }
    }

    /** Connect Device: discovered and remembered devices, plus manual entry. Discovery runs while the chooser is open. */
    fun connect(project: Project?, component: Component? = null, title: String = "Connect Device") {
        if (!requireAdb(project)) return
        val lease = svc.beginSearch()
        background(project, "Discovering Android devices") {
            runCatching { svc.browser?.refresh() }
            ApplicationManager.getApplication().invokeLater {
                val entries = svc.entries().filter { it.transport == Transport.WIFI && it.status != EntryStatus.CONNECTED && it.endpoint != null }
                val manual = "Enter IP address and port…"
                val items: List<Any> = entries + manual
                val step = object : BaseListPopupStep<Any>(title, items) {
                    override fun getTextFor(value: Any) = if (value is DeviceEntry) "${value.name}  ·  ${value.endpoint}" + when {
                        !value.known -> "  (discovered)"
                        value.status == EntryStatus.AVAILABLE -> "  (remembered, advertising)"
                        else -> "  (remembered, last address)"
                    } else value.toString()
                    override fun getIconFor(value: Any): Icon = if (value is DeviceEntry) AllIcons.Nodes.Plugin else AllIcons.Actions.Edit
                    override fun onChosen(selected: Any, finalChoice: Boolean): PopupStep<*>? {
                        doFinalStep {
                            if (selected is DeviceEntry) deviceOp(project, "connect", selected)
                            else promptEndpoint(project)?.let { connectEndpoint(project, it) }
                        }
                        return FINAL_CHOICE
                    }
                }
                val popup = JBPopupFactory.getInstance().createListPopup(step)
                popup.addListener(object : com.intellij.openapi.ui.popup.JBPopupListener {
                    override fun onClosed(event: com.intellij.openapi.ui.popup.LightweightWindowEvent) { lease?.release() }
                })
                when {
                    component != null -> popup.showUnderneathOf(component)
                    project != null -> popup.showCenteredInCurrentWindow(project)
                    else -> popup.showInFocusCenter()
                }
            }
        }
    }

    fun promptEndpoint(project: Project?): String? = Messages.showInputDialog(project,
        "IP address & Port from Wireless debugging (not the pairing port):", "Connect by IP:Port", null, "",
        object : InputValidator {
            override fun checkInput(s: String?) = Endpoints.valid(s)
            override fun canClose(s: String?) = Endpoints.valid(s)
        })?.trim()

    fun reconnect(project: Project?) {
        if (!requireAdb(project)) return
        val m = svc.connections ?: return
        if (m.known.isEmpty()) {
            svc.notify(project, "No remembered devices yet. Pair or connect a device first.")
            return
        }
        background(project, "Reconnecting Android devices") {
            val rs = m.reconnectAll(ReconnectReason.MANUAL)
            val failed = rs.filter { !it.ok }
            if (failed.isNotEmpty()) fail(project, "Reconnected ${rs.size - failed.size} of ${rs.size}", failed.joinToString("\n") { "${it.device?.name}: ${it.message}" })
            else if (rs.isNotEmpty()) svc.notify(project, "Reconnected ${rs.size} device(s)")
        }
    }

    fun disconnect(project: Project?, component: Component? = null) {
        if (!requireAdb(project)) return
        val wifi = svc.entries().filter { it.transport == Transport.WIFI && it.serial != null }
        when {
            wifi.isEmpty() -> svc.notify(project, "No wireless device is connected.")
            wifi.size == 1 -> deviceOp(project, "disconnect", wifi.first())
            else -> {
                val step = object : BaseListPopupStep<DeviceEntry>("Disconnect Device", wifi) {
                    override fun getTextFor(value: DeviceEntry) = "${value.name}  ·  ${value.endpoint ?: value.serial}"
                    override fun onChosen(selected: DeviceEntry, finalChoice: Boolean): PopupStep<*>? {
                        doFinalStep { deviceOp(project, "disconnect", selected) }
                        return FINAL_CHOICE
                    }
                }
                val popup = JBPopupFactory.getInstance().createListPopup(step)
                if (component != null) popup.showUnderneathOf(component) else if (project != null) popup.showCenteredInCurrentWindow(project)
            }
        }
    }

    fun pairQr(project: Project?) {
        if (!requireAdb(project)) return
        QrPairingDialog(project).show()
    }

    fun pairCode(project: Project?) {
        if (!requireAdb(project)) return
        val c = svc.client ?: return
        if (!c.info.version.wirelessPairing) {
            fail(project, "Pairing unavailable", "Wireless pairing needs Android SDK Platform-Tools 31 or newer.")
            return
        }
        PairCodeDialog(project).show()
    }

    fun openManager(project: Project?) {
        project ?: return
        ToolWindowManager.getInstance(project).getToolWindow("ADB Connect")?.show()
    }

    fun openLogs(project: Project?) {
        project ?: return
        val tw = ToolWindowManager.getInstance(project).getToolWindow("ADB Connect") ?: return
        tw.show { tw.contentManager.findContent("Logs")?.let { tw.contentManager.setSelectedContent(it) } }
    }

    fun openSettings(project: Project?) = ShowSettingsUtil.getInstance().showSettingsDialog(project, AdbConnectConfigurable::class.java)

    fun deviceOp(project: Project?, op: String, e: DeviceEntry) {
        val m = svc.connections ?: return
        when (op) {
            "connect", "reconnect" ->
                if (e.known) background(project, "Connecting ${e.name}") {
                    val r = m.reconnect(e.id, ReconnectReason.MANUAL)
                    if (!r.ok) fail(project, "Could not connect ${e.name}", r.message)
                } else e.endpoint?.let { connectEndpoint(project, it, if (e.advertisedName != null) null else e.name) }
            "disconnect" -> e.serial?.let { serial ->
                background(project, "Disconnecting ${e.name}") {
                    val r = m.disconnect(serial)
                    if (!r.ok) fail(project, "Disconnect failed", r.message)
                }
            }
            "prefer" -> {
                settings.preferredDevice = if (e.preferred) "" else e.id
                svc.settingsChanged(adbPathChanged = false)
            }
            "forget" -> if (Messages.showYesNoDialog(project,
                    "Forget ${e.name}? It will no longer reconnect automatically. The phone stays paired with adb until you revoke it on the phone.",
                    "Forget Device", Messages.getQuestionIcon()) == Messages.YES) AdbConnectService.pooled { m.forget(e.id) }
            "toggleAuto" -> AdbConnectService.pooled { m.setDeviceAutoReconnect(e.id, !(e.autoReconnect ?: true)) }
            "copySerial" -> CopyPasteManager.getInstance().setContents(StringSelection(e.serial ?: e.endpoint ?: e.id))
        }
    }

    fun copyCommandPopup(component: Component, e: DeviceEntry) {
        val step = object : BaseListPopupStep<Pair<String, String>>("adb Commands for ${e.name}", e.adbCommands()) {
            override fun getTextFor(value: Pair<String, String>) = "${value.first}:  ${value.second}"
            override fun onChosen(selected: Pair<String, String>, finalChoice: Boolean): PopupStep<*>? {
                CopyPasteManager.getInstance().setContents(StringSelection(selected.second))
                return FINAL_CHOICE
            }
        }
        JBPopupFactory.getInstance().createListPopup(step).showUnderneathOf(component)
    }

    /** Status-bar / Tools quick actions: connected devices on top, then the standard actions. */
    fun showQuickActions(project: Project?, component: Component) {
        val group = DefaultActionGroup()
        val connected = svc.entries().filter { it.status == EntryStatus.CONNECTED }
        for (e in connected) {
            val sub = DefaultActionGroup("${e.name}  (${e.endpoint ?: e.serial})", true).apply {
                templatePresentation.icon = AllIcons.General.InspectionsOK
                if (e.transport == Transport.WIFI) add(simple("Disconnect", AllIcons.Actions.Suspend) { deviceOp(project, "disconnect", e) })
                add(simple(if (e.preferred) "Unset Preferred Device" else "Set as Preferred Device", AllIcons.Nodes.Favorite) { deviceOp(project, "prefer", e) })
                add(simple("Copy Serial", AllIcons.Actions.Copy) { deviceOp(project, "copySerial", e) })
                add(simple("Copy adb Command…", AllIcons.Debugger.Console) { copyCommandPopup(component, e) })
            }
            group.add(sub)
        }
        if (connected.isNotEmpty()) group.add(Separator.getInstance())
        val am = ActionManager.getInstance()
        listOf("AdbConnect.Connect", "AdbConnect.Reconnect", "AdbConnect.Disconnect", null,
            "AdbConnect.PairQr", "AdbConnect.PairCode", "AdbConnect.Discover", null,
            "AdbConnect.ManageDevices", "AdbConnect.Settings", "AdbConnect.ViewLogs").forEach { id ->
            if (id == null) group.add(Separator.getInstance()) else am.getAction(id)?.let(group::add)
        }
        JBPopupFactory.getInstance()
            .createActionGroupPopup("ADB Connect", group, DataManager.getInstance().getDataContext(component), JBPopupFactory.ActionSelectionAid.SPEEDSEARCH, true)
            .showUnderneathOf(component)
    }

    private fun simple(text: String, icon: Icon, run: () -> Unit) = object : DumbAwareAction(text, null, icon) {
        override fun actionPerformed(e: AnActionEvent) = run()
        override fun getActionUpdateThread() = ActionUpdateThread.BGT
    }
}

abstract class AdbAction : DumbAwareAction() {
    override fun getActionUpdateThread() = ActionUpdateThread.BGT
}

class QuickActionsAction : AdbAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val c = e.inputEvent?.component ?: return AdbUi.openManager(e.project)
        AdbUi.showQuickActions(e.project, c)
    }
}
class ConnectAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.connect(e.project) }
class ReconnectAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.reconnect(e.project) }
class DisconnectAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.disconnect(e.project) }
class PairQrAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.pairQr(e.project) }
class PairCodeAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.pairCode(e.project) }
class DiscoverAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.connect(e.project, title = "Discover Devices") }
class ManageDevicesAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.openManager(e.project) }
class SettingsAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.openSettings(e.project) }
class ViewLogsAction : AdbAction() { override fun actionPerformed(e: AnActionEvent) = AdbUi.openLogs(e.project) }
