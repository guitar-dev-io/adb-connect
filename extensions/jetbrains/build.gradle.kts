import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.4.21"
    id("org.jetbrains.intellij.platform") version "2.19.0"
}

group = providers.gradleProperty("pluginGroup").get()
version = providers.gradleProperty("pluginVersion").get()

repositories {
    mavenCentral()
    intellijPlatform { defaultRepositories() }
}

dependencies {
    intellijPlatform {
        val local = providers.gradleProperty("platformLocalPath").orNull
        if (!local.isNullOrBlank()) local(local)
        else create(providers.gradleProperty("platformType"), providers.gradleProperty("platformVersion"))
    }
    // QR encoder (Apache-2.0), bundled into the plugin ZIP.
    implementation("com.google.zxing:core:3.5.4")

    testImplementation("junit:junit:4.13.2")
    testImplementation("com.google.code.gson:gson:2.13.2")
}

java {
    sourceCompatibility = JavaVersion.VERSION_21
    targetCompatibility = JavaVersion.VERSION_21
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_21)
        // Stay compatible with the Kotlin stdlib bundled in 2024.3+.
        apiVersion.set(KotlinVersion.KOTLIN_2_0)
        languageVersion.set(KotlinVersion.KOTLIN_2_0)
    }
}

intellijPlatform {
    pluginConfiguration {
        version = providers.gradleProperty("pluginVersion")
        ideaVersion {
            sinceBuild = providers.gradleProperty("pluginSinceBuild")
            untilBuild = provider { null }
        }
    }
    instrumentCode = false
    buildSearchableOptions = false
    pluginVerification {
        ides { recommended() }
    }
}

tasks {
    test {
        useJUnit()
        // Shared parser vectors, also used by the TypeScript core.
        systemProperty("adbconnect.fixtures", rootDir.resolve("../../packages/core/fixtures/adb-output.json").absolutePath)
    }
}
