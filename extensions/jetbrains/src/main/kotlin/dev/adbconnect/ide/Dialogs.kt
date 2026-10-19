package dev.adbconnect.ide

import com.intellij.icons.AllIcons
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.ValidationInfo
import com.intellij.ui.JBColor
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBPasswordField
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import dev.adbconnect.core.Endpoints
import dev.adbconnect.core.MdnsBrowser
import dev.adbconnect.core.MdnsService
import dev.adbconnect.core.Pairing
import dev.adbconnect.core.PairingState
import dev.adbconnect.core.PairingUpdate
import dev.adbconnect.core.QrEncoder
import dev.adbconnect.core.QrPairingSession
import dev.adbconnect.core.ServiceType
import java.awt.BorderLayout
import java.awt.Color
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.event.ActionEvent
import java.awt.image.BufferedImage
import javax.swing.AbstractAction
import javax.swing.Action
import javax.swing.BoxLayout
import javax.swing.DefaultComboBoxModel
import javax.swing.ImageIcon
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants
import javax.swing.Timer

private fun ui(block: () -> Unit) = ApplicationManager.getApplication().invokeLater(block, ModalityState.any())

/**
 * Real Android Wireless Debugging QR pairing. Each attempt uses fresh one-time credentials,
 * kept only in memory. The phone advertises the pairing service; adb performs the SPAKE2/TLS pairing.
 */
class QrPairingDialog(private val project: Project?) : DialogWrapper(project, false) {
    private val svc = AdbConnectService.get()
    private val qrLabel = JBLabel().apply { horizontalAlignment = SwingConstants.CENTER }
    private val stateLabel = JBLabel(" ").apply { horizontalAlignment = SwingConstants.CENTER }
    private val countdown = JBLabel(" ").apply { horizontalAlignment = SwingConstants.CENTER; foreground = UIUtil.getContextHelpForeground() }
    @Volatile private var session: QrPairingSession? = null
    private var current = PairingState.WAITING_FOR_SCAN
    private var expiresAt = 0L
    private val ticker = Timer(1000) { updateCountdown() }
    private val retryAction = object : AbstractAction("Retry") {
        override fun actionPerformed(e: ActionEvent?) = start()
    }
    private val useCodeAction = object : AbstractAction("Use Pairing Code Instead") {
        override fun actionPerformed(e: ActionEvent?) {
            close(CANCEL_EXIT_CODE)
            AdbUi.pairCode(project)
        }
    }

    init {
        title = "Pair via QR Code"
        setCancelButtonText("Cancel")
        retryAction.isEnabled = false
        init()
        start()
        ticker.start()
    }

    override fun createCenterPanel(): JComponent {
        val p = JPanel()
        p.layout = BoxLayout(p, BoxLayout.Y_AXIS)
        p.border = JBUI.Borders.empty(8, 16)
        val qrBox = JPanel(BorderLayout()).apply {
            background = Color.WHITE // QR needs a light quiet zone in every theme
            border = JBUI.Borders.empty(8)
            add(qrLabel, BorderLayout.CENTER)
            maximumSize = Dimension(JBUI.scale(300), JBUI.scale(300))
            alignmentX = JComponent.CENTER_ALIGNMENT
        }
        fun centered(c: JComponent) = c.apply { alignmentX = JComponent.CENTER_ALIGNMENT }
        p.add(qrBox)
        p.add(javax.swing.Box.createVerticalStrut(JBUI.scale(12)))
        p.add(centered(JBLabel("<html><div style='text-align:center;width:320px'>On your Android device open <b>Settings › Developer options › Wireless debugging</b> and tap <b>Pair device with QR code</b>.</div></html>")))
        p.add(javax.swing.Box.createVerticalStrut(JBUI.scale(10)))
        p.add(centered(stateLabel))
        p.add(centered(countdown))
        p.add(javax.swing.Box.createVerticalStrut(JBUI.scale(10)))
        p.add(centered(JBLabel("<html><div style='width:340px'><b>Having trouble?</b><ul>" +
            "<li>Requires Android 11+ and Platform-Tools 31+.</li>" +
            "<li>Phone and computer must share a Wi-Fi network; guest networks / AP isolation block discovery.</li>" +
            "<li>Turn off mobile data if the phone keeps switching networks.</li>" +
            "<li>VPNs or firewalls blocking mDNS (UDP 5353) prevent discovery — use the pairing code instead.</li></ul></div></html>").apply {
            foreground = UIUtil.getContextHelpForeground()
        }))
        return p
    }

    override fun createLeftSideActions(): Array<Action> = arrayOf(useCodeAction)
    override fun createActions(): Array<Action> = arrayOf(retryAction, cancelAction)

    private fun start() {
        session?.cancel()
        val client = svc.client ?: return
        val browser = svc.browser ?: return
        val s = QrPairingSession(client, browser, scanTimeoutMs = SCAN_TIMEOUT_MS)
        session = s
        qrLabel.icon = ImageIcon(render(s.payload, JBUI.scale(280)))
        qrLabel.isEnabled = true
        expiresAt = System.currentTimeMillis() + SCAN_TIMEOUT_MS
        retryAction.isEnabled = false
        setState(PairingUpdate(PairingState.WAITING_FOR_SCAN, "Preparing…"))
        svc.pairing = true
        AdbConnectService.pooled {
            val result = s.run { u -> if (session === s) ui { setState(u) } }
            if (session === s) {
                svc.connections?.recordPairing(result)
                svc.pairing = false
                ui {
                    retryAction.isEnabled = true
                    if (result.state == PairingState.CONNECTED) svc.notify(project, "Paired and connected: ${result.device?.model ?: result.endpoint}")
                }
            }
        }
    }

    private fun setState(u: PairingUpdate) {
        current = u.state
        val (icon, color) = when (u.state) {
            PairingState.CONNECTED -> AllIcons.General.InspectionsOK to JBColor.namedColor("Label.successForeground", JBColor(0x2E7D32, 0x5FB865))
            PairingState.FAILED, PairingState.TIMEOUT -> AllIcons.General.Error to JBColor.namedColor("Label.errorForeground", JBColor.RED)
            PairingState.PAIRED, PairingState.CANCELLED -> AllIcons.General.Information to UIUtil.getLabelForeground()
            else -> AllIcons.Process.Step_1 to UIUtil.getLabelForeground()
        }
        stateLabel.icon = icon
        stateLabel.foreground = color
        stateLabel.text = if (u.state == PairingState.CONNECTED) "Connected! ${u.device?.model ?: ""}  ${u.endpoint ?: ""}".trim() else u.message
        qrLabel.isEnabled = u.state == PairingState.WAITING_FOR_SCAN
        if (u.state.isFinal) countdown.text = " "
        if (u.state == PairingState.CONNECTED) setCancelButtonText("Done")
    }

    private fun updateCountdown() {
        if (current != PairingState.WAITING_FOR_SCAN || session == null) return
        val s = ((expiresAt - System.currentTimeMillis()) / 1000).coerceAtLeast(0)
        countdown.text = "Code expires in %d:%02d".format(s / 60, s % 60)
    }

    override fun dispose() {
        ticker.stop()
        session?.cancel()
        session = null
        svc.pairing = false
        super.dispose()
    }

    companion object {
        const val SCAN_TIMEOUT_MS = 120_000L

        fun render(payload: String, size: Int): BufferedImage {
            val m = QrEncoder.matrix(payload, size)
            val img = BufferedImage(m.width, m.height, BufferedImage.TYPE_INT_RGB)
            for (y in 0 until m.height) for (x in 0 until m.width) img.setRGB(x, y, if (m.get(x, y)) 0x000000 else 0xFFFFFF)
            return img
        }
    }
}

/**
 * Six-digit code pairing. While open, the phone's "Pair device with pairing code" dialog is
 * discovered over mDNS and offered in the endpoint field, so typing the address is rarely needed.
 */
class PairCodeDialog(private val project: Project?) : DialogWrapper(project, true) {
    private val svc = AdbConnectService.get()
    private val model = DefaultComboBoxModel<String>()
    private val endpoint = ComboBox(model).apply { isEditable = true; prototypeDisplayValue = "192.168.100.100:40000   (adb-XXXXXXXX)" }
    private val code = JBPasswordField().apply { columns = 8 }
    private val hint = JBLabel("Waiting for a phone in pairing mode…").apply { foreground = UIUtil.getContextHelpForeground() }
    private val lease: MdnsBrowser.Lease? = svc.beginSearch()
    private val listener: (List<MdnsService>, List<MdnsService>) -> Unit = { all, _ -> ui { offer(all) } }

    init {
        title = "Pair via Pairing Code"
        setOKButtonText("Pair")
        init()
        svc.browser?.addListener(listener)
        svc.browser?.services?.let(::offer)
    }

    private fun offer(all: List<MdnsService>) {
        val pairing = all.filter { it.type == ServiceType.PAIRING && !it.name.startsWith("adbconnect-") }
        val typed = endpoint.editor.item?.toString().orEmpty()
        for (s in pairing) if (model.getIndexOf(s.endpoint) < 0) model.addElement(s.endpoint)
        if (typed.isBlank() && pairing.isNotEmpty()) endpoint.selectedItem = pairing.first().endpoint
        hint.text = if (pairing.isEmpty()) "Waiting for a phone in pairing mode… or type the IP address & Port." else "Found ${pairing.size} phone(s) in pairing mode."
    }

    override fun createCenterPanel(): JComponent {
        val p = JPanel()
        p.layout = BoxLayout(p, BoxLayout.Y_AXIS)
        p.add(JBLabel("<html>On the phone: <b>Wireless debugging › Pair device with pairing code</b>.</html>"))
        p.add(javax.swing.Box.createVerticalStrut(JBUI.scale(8)))
        p.add(JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply { add(JBLabel("IP address & Port:  ")); add(endpoint) })
        p.add(hint)
        p.add(javax.swing.Box.createVerticalStrut(JBUI.scale(8)))
        p.add(JPanel(FlowLayout(FlowLayout.LEFT, 0, 0)).apply { add(JBLabel("Wi-Fi pairing code:  ")); add(code) })
        return p
    }

    override fun getPreferredFocusedComponent(): JComponent = code

    private fun endpointValue() = endpoint.editor.item?.toString()?.trim().orEmpty()

    override fun doValidate(): ValidationInfo? = when {
        !Endpoints.valid(endpointValue()) -> ValidationInfo("Enter the pairing IP address & Port, e.g. 192.168.1.20:42761", endpoint)
        !Endpoints.validPairingCode(String(code.password)) -> ValidationInfo("Enter exactly 6 digits", code)
        else -> null
    }

    override fun doOKAction() {
        val ep = endpointValue()
        val pin = String(code.password)
        code.text = ""
        super.doOKAction()
        val client = svc.client ?: return
        val browser = svc.browser ?: return
        svc.pairing = true
        com.intellij.openapi.progress.ProgressManager.getInstance().run(object : com.intellij.openapi.progress.Task.Backgroundable(project, "Pairing with $ep", true) {
            override fun run(indicator: com.intellij.openapi.progress.ProgressIndicator) {
                try {
                    val r = Pairing.pairWithCode(client, browser, ep, pin, { indicator.isCanceled }) { indicator.text = it.message }
                    svc.connections?.recordPairing(r)
                    when (r.state) {
                        PairingState.CONNECTED -> svc.notify(project, "Paired and connected: ${r.device?.model ?: r.endpoint}")
                        PairingState.PAIRED -> svc.notify(project, r.message, com.intellij.notification.NotificationType.WARNING)
                        PairingState.CANCELLED -> Unit
                        else -> svc.notify(project, "Pairing failed: ${r.message}", com.intellij.notification.NotificationType.ERROR)
                    }
                } finally {
                    svc.pairing = false
                }
            }
        })
    }

    override fun dispose() {
        svc.browser?.removeListener(listener)
        lease?.release()
        super.dispose()
    }
}
