plugins {
  id("org.jetbrains.intellij.platform") version "2.6.0"
  kotlin("jvm") version "2.1.20"
}
repositories { mavenCentral(); intellijPlatform { defaultRepositories() } }
dependencies { intellijPlatform { intellijIdeaCommunity("2024.3") } }
intellijPlatform { pluginConfiguration { name = "ADB Connect"; version = "0.1.0"; ideaVersion { sinceBuild = "243" } } }
tasks { withType<org.jetbrains.kotlin.gradle.tasks.KotlinCompile> { compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21) } }
