package dev.adbconnect.ide

import com.intellij.openapi.fileChooser.FileChooser
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.options.BoundConfigurable
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.panel
import javax.swing.JTextField

/** Settings › Tools › ADB Connect */
class AdbConnectConfigurable : BoundConfigurable("ADB Connect") {
    private val s = AdbConnectSettings.get()
    private var oldPath = s.adbPath
    private var oldShow = s.showStatusBar

    override fun createPanel(): DialogPanel = panel {
        group("ADB") {
            row("adb executable:") {
                lateinit var field: JTextField
                field = textField().bindText(s::adbPath).align(AlignX.FILL)
                    .comment("Leave empty to auto-detect (ANDROID_HOME, ANDROID_SDK_ROOT, PATH, default SDK location).").component
                button("Browse…") {
                    FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFileNoJarsDescriptor().withTitle("Select the adb Executable"), null, null)
                        ?.let { field.text = it.path }
                }
            }
        }
        group("Connection") {
            row { checkBox("Auto discover devices on the network (mDNS)").bindSelected(s::autoDiscover) }
            row { checkBox("Auto reconnect remembered devices").bindSelected(s::autoReconnect)
                .comment("Only devices you paired or connected before, only while they advertise Wireless debugging, never after you disconnect them.") }
            row { checkBox("Reconnect on IDE startup").bindSelected(s::reconnectOnStartup) }
            row("Preferred device id:") { textField().bindText(s::preferredDevice).comment("Set from the ADB Connect tool window (star button). Does not change other tools' device selection.") }
        }
        group("Interface") {
            row { checkBox("Show device status in the status bar").bindSelected(s::showStatusBar) }
            row { checkBox("Debug logging (every adb call, secrets redacted)").bindSelected(s::debugLogging) }
        }
    }

    override fun apply() {
        super.apply()
        AdbConnectService.get().settingsChanged(adbPathChanged = s.adbPath != oldPath)
        if (s.showStatusBar != oldShow) AdbStatusBarWidgetFactory.refreshAll()
        oldPath = s.adbPath
        oldShow = s.showStatusBar
    }
}
