# JetBrains plugin (experimental scaffold)

Includes IntelliJ Platform Gradle metadata and an actual `ADB Connect: Devices` action. The action shows `adb devices -l` results. It is **not** feature-parity with VS Code. Needs Gradle/network access, IDE SDK download, real compilation and compatibility validation. No JetBrains ZIP artifact is included yet.

Build with installed Gradle: `gradle buildPlugin`. For Android Studio, test SDK build compatibility first (do not claim blanket support).
