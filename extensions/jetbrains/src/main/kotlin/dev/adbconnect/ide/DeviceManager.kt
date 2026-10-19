package dev.adbconnect.ide

import com.intellij.icons.AllIcons
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTextArea
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import dev.adbconnect.core.DeviceEntry
import dev.adbconnect.core.EntryStatus
import dev.adbconnect.core.Transport
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.Font
import javax.swing.Box
import javax.swing.BoxLayout
import javax.swing.Icon
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

class AdbToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val cf = ContentFactory.getInstance()
        val devices = DeviceManagerPanel(project)
        toolWindow.contentManager.addContent(cf.createContent(devices, "Devices", false).apply { setDisposer(devices) })
        val logs = LogsPanel()
        toolWindow.contentManager.addContent(cf.createContent(logs, "Logs", false).apply { setDisposer(logs) })
        AdbConnectService.get().ensureStarted()
    }
}

/** Native device manager: one card per device with one-click connection management. */
class DeviceManagerPanel(private val project: Project) : JPanel(BorderLayout()), com.intellij.openapi.Disposable {
    private val svc = AdbConnectService.get()
    private val list = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS); border = JBUI.Borders.empty(8) }
    private val header = JBLabel().apply { foreground = UIUtil.getContextHelpForeground(); border = JBUI.Borders.empty(6, 10) }
    private var lastKey = ""

    init {
        val group = DefaultActionGroup().apply {
            val am = ActionManager.getInstance()
            listOf("AdbConnect.PairQr", "AdbConnect.PairCode", "AdbConnect.Connect", "AdbConnect.Discover", "AdbConnect.Reconnect", "AdbConnect.Settings")
                .mapNotNull(am::getAction).forEach(::add)
        }
        val toolbar = ActionManager.getInstance().createActionToolbar(ActionPlaces.TOOLWINDOW_CONTENT, group, true)
        toolbar.targetComponent = this
        add(JPanel(BorderLayout()).apply { add(toolbar.component, BorderLayout.WEST); add(header, BorderLayout.SOUTH) }, BorderLayout.NORTH)
        add(JBScrollPane(list).apply { border = JBUI.Borders.empty() }, BorderLayout.CENTER)
        svc.addListener(this) { ApplicationManager.getApplication().invokeLater({ refresh() }, { project.isDisposed }) }
        refresh()
    }

    private fun refresh() {
        val entries = svc.entries()
        val info = svc.client?.info?.version
        val key = entries.toString() + svc.activity() + svc.startError + info
        if (key == lastKey) return // avoid rebuilding (and losing focus) when nothing changed
        lastKey = key
        header.text = when {
            svc.startError != null -> "adb unavailable: ${svc.startError}"
            info != null -> "adb ${info.adb} · platform-tools ${info.platformTools ?: "?"} · ${entries.count { it.status == EntryStatus.CONNECTED }} connected" +
                when (svc.activity()) { Activity.SEARCHING -> " · searching…"; Activity.RECONNECTING -> " · reconnecting…"; Activity.PAIRING -> " · pairing…"; else -> "" }
            else -> "Starting…"
        }
        header.foreground = if (svc.startError != null) JBColor.namedColor("Label.errorForeground", JBColor.RED) else UIUtil.getContextHelpForeground()
        list.removeAll()
        if (entries.isEmpty()) list.add(emptyState()) else entries.forEach { list.add(card(it)); list.add(Box.createVerticalStrut(JBUI.scale(6))) }
        list.add(Box.createVerticalGlue())
        list.revalidate()
        list.repaint()
    }

    private fun emptyState(): JComponent = JBLabel(
        "<html><b>No devices yet.</b><ol>" +
            "<li>On the phone (Android 11+): Settings › Developer options › Wireless debugging — turn it on.</li>" +
            "<li>Make sure the phone and this computer are on the same Wi-Fi.</li>" +
            "<li>Click <b>Pair via QR Code</b> in the toolbar and scan from “Pair device with QR code”.</li></ol></html>",
    ).apply { border = JBUI.Borders.empty(12); alignmentX = LEFT_ALIGNMENT }

    private fun card(e: DeviceEntry): JComponent {
        val statusColor = when (e.status) {
            EntryStatus.CONNECTED -> JBColor.namedColor("Label.successForeground", JBColor(0x2E7D32, 0x5FB865))
            EntryStatus.OFFLINE -> JBColor.namedColor("Label.errorForeground", JBColor.RED)
            EntryStatus.UNAUTHORIZED, EntryStatus.CONNECTING -> JBColor(0xA36B00, 0xD9A343)
            else -> UIUtil.getContextHelpForeground()
        }
        val transport = if (e.transport == Transport.WIFI) "Wi-Fi" else "USB"
        val meta = listOfNotNull(e.endpoint ?: e.serial, transport, e.serial?.takeIf { it != e.endpoint }, "disconnected by you".takeIf { e.userDisconnected == true })
        val badges = listOfNotNull(e.status.label, "Paired".takeIf { e.paired }, "Auto-reconnect".takeIf { e.known && e.autoReconnect != false }, "Preferred".takeIf { e.preferred })

        val info = JPanel().apply {
            layout = BoxLayout(this, BoxLayout.Y_AXIS); isOpaque = false
            add(JBLabel(e.name, if (e.status == EntryStatus.CONNECTED) AllIcons.General.InspectionsOK else AllIcons.Nodes.EmptyNode, SwingConstants.LEFT).apply { font = font.deriveFont(Font.BOLD) })
            add(JBLabel(meta.joinToString(" · ")).apply { foreground = UIUtil.getContextHelpForeground() })
            add(JBLabel(badges.joinToString("  •  ")).apply { foreground = statusColor })
            if (e.advertisedName != null) add(JBLabel("Discovered on the network — connecting works only if it was paired with this computer.").apply { foreground = UIUtil.getContextHelpForeground() })
        }

        val actions = JPanel(FlowLayout(FlowLayout.RIGHT, JBUI.scale(4), 0)).apply { isOpaque = false }
        fun button(text: String, icon: Icon?, op: () -> Unit, tooltip: String? = null) = JButton(text, icon).apply {
            toolTipText = tooltip ?: text
            if (text.isEmpty()) { putClientProperty("JButton.buttonType", "toolbar"); preferredSize = Dimension(JBUI.scale(28), JBUI.scale(28)) }
            addActionListener { op() }
            getAccessibleContext().accessibleName = "${tooltip ?: text} ${e.name}"
        }
        when {
            e.status == EntryStatus.CONNECTED && e.transport == Transport.WIFI -> actions.add(button("Disconnect", AllIcons.Actions.Suspend, { AdbUi.deviceOp(project, "disconnect", e) }))
            e.transport == Transport.WIFI && e.status in setOf(EntryStatus.AVAILABLE, EntryStatus.DISCONNECTED, EntryStatus.OFFLINE) ->
                actions.add(button(if (e.known) "Reconnect" else "Connect", AllIcons.Actions.Refresh, { AdbUi.deviceOp(project, if (e.known) "reconnect" else "connect", e) }))
        }
        if (e.status == EntryStatus.CONNECTED) actions.add(button("", AllIcons.Nodes.Favorite, { AdbUi.deviceOp(project, "prefer", e) }, if (e.preferred) "Unset preferred device" else "Set as preferred device"))
        if (e.serial != null || e.endpoint != null) {
            actions.add(button("", AllIcons.Actions.Copy, { AdbUi.deviceOp(project, "copySerial", e) }, "Copy serial"))
            lateinit var cmd: JButton
            cmd = button("", AllIcons.Debugger.Console, { AdbUi.copyCommandPopup(cmd, e) }, "Copy adb command")
            actions.add(cmd)
        }
        if (e.known) {
            actions.add(button("", if (e.autoReconnect != false) AllIcons.Actions.Lightning else AllIcons.Actions.Pause, { AdbUi.deviceOp(project, "toggleAuto", e) },
                if (e.autoReconnect != false) "Auto-reconnect on (click to turn off)" else "Auto-reconnect off (click to turn on)"))
            actions.add(button("", AllIcons.Actions.GC, { AdbUi.deviceOp(project, "forget", e) }, "Forget device"))
        }

        return JPanel(BorderLayout(JBUI.scale(10), JBUI.scale(4))).apply {
            border = JBUI.Borders.compound(
                JBUI.Borders.customLine(if (e.preferred) JBColor.namedColor("Component.focusColor", JBColor.BLUE) else JBColor.border(), 1),
                JBUI.Borders.empty(10, 12),
            )
            background = JBColor.namedColor("Panel.background", UIUtil.getPanelBackground())
            add(info, BorderLayout.CENTER)
            add(actions, BorderLayout.SOUTH)
            maximumSize = Dimension(Int.MAX_VALUE, preferredSize.height)
            alignmentX = LEFT_ALIGNMENT
        }
    }

    override fun dispose() = Unit
}

class LogsPanel : JPanel(BorderLayout()), com.intellij.openapi.Disposable {
    private val area = JBTextArea().apply { isEditable = false; font = Font(Font.MONOSPACED, Font.PLAIN, UIUtil.getLabelFont().size) }

    init {
        val svc = AdbConnectService.get()
        val bar = JPanel(FlowLayout(FlowLayout.LEFT)).apply {
            add(JButton("Copy").apply { addActionListener { com.intellij.openapi.ide.CopyPasteManager.getInstance().setContents(java.awt.datatransfer.StringSelection(area.text)) } })
            add(JButton("Clear").apply { addActionListener { svc.log.clear() } })
            add(JBLabel("Secrets (pairing codes / QR passwords) are never logged.").apply { foreground = UIUtil.getContextHelpForeground() })
        }
        add(bar, BorderLayout.NORTH)
        add(JBScrollPane(area), BorderLayout.CENTER)
        val update = { ApplicationManager.getApplication().invokeLater { area.text = svc.log.text(); area.caretPosition = area.document.length } }
        svc.log.addListener(this) { update() }
        update()
    }

    override fun dispose() = Unit
}
