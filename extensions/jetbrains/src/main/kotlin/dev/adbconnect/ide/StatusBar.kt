package dev.adbconnect.ide

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.project.ProjectManager
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.openapi.wm.impl.status.widget.StatusBarWidgetsManager
import com.intellij.util.Consumer
import java.awt.Component
import java.awt.event.MouseEvent

class AdbStatusBarWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = ID
    override fun getDisplayName() = "ADB Connect"
    override fun isAvailable(project: Project) = AdbConnectSettings.get().showStatusBar
    override fun createWidget(project: Project): StatusBarWidget = AdbStatusBarWidget(project)
    override fun isEnabledByDefault() = true

    companion object {
        const val ID = "AdbConnectStatus"

        /** Re-evaluate isAvailable() in every open project (after the "show status bar" setting changes). */
        fun refreshAll() {
            for (p in ProjectManager.getInstance().openProjects) {
                if (!p.isDisposed) p.getService(StatusBarWidgetsManager::class.java)?.updateWidget(AdbStatusBarWidgetFactory::class.java)
            }
        }
    }
}

class AdbStatusBarWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private var statusBar: StatusBar? = null

    override fun ID() = AdbStatusBarWidgetFactory.ID
    override fun getPresentation() = this

    override fun install(statusBar: StatusBar) {
        this.statusBar = statusBar
        val svc = AdbConnectService.get()
        svc.addListener(this) { ApplicationManager.getApplication().invokeLater { this.statusBar?.updateWidget(ID()) } }
        svc.ensureStarted()
    }

    override fun getText(): String = AdbConnectService.get().statusText().first
    override fun getTooltipText(): String = AdbConnectService.get().statusText().second.replace("\n", "<br>").let { "<html>$it<br><i>Click for ADB Connect actions</i></html>" }
    override fun getAlignment(): Float = Component.CENTER_ALIGNMENT

    @Suppress("OVERRIDE_DEPRECATION")
    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { e ->
        if (AdbConnectService.get().client == null) AdbUi.requireAdb(project) else AdbUi.showQuickActions(project, e.component)
    }

    override fun dispose() {
        statusBar = null
        Disposer.dispose(this)
    }
}

/** Start the engine (and startup reconnect) once the first project opens. */
class AdbStartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) {
        AdbConnectService.get().ensureStarted()
    }
}
