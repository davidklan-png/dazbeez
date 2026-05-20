import SwiftUI

struct RootView: View {
    @EnvironmentObject private var environment: AppEnvironment

    var body: some View {
        if environment.deviceToken == nil {
            PairingView()
        } else {
            HomeView()
        }
    }
}
