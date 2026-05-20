import SwiftUI

@main
struct DazbeezCaptureApp: App {
    @StateObject private var environment = AppEnvironment()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(environment)
                .task {
                    await environment.bootstrap()
                }
        }
    }
}
