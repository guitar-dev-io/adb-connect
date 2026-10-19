package dev.adbconnect

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.ui.Messages
import java.util.concurrent.TimeUnit

/** JetBrains technology preview, not the full device manager from VS Code. */
class AdbConnectAction : AnAction() {
    override fun actionPerformed(e: AnActionEvent) {
        ApplicationManager.getApplication().executeOnPooledThread {
            val result = try {
                val process = ProcessBuilder("adb", "devices", "-l").redirectErrorStream(true).start()
                val finished = process.waitFor(8, TimeUnit.SECONDS)
                if (!finished) { process.destroyForcibly(); "ADB command timed out" }
                else process.inputStream.bufferedReader().readText().take(12000)
            } catch (ex: Exception) { "Unable to execute ADB: ${ex.message}" }
            ApplicationManager.getApplication().invokeLater {
                Messages.showInfoMessage(e.project, result, "ADB Connect - Device List")
            }
        }
    }
}
