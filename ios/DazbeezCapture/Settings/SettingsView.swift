import SwiftUI

struct SettingsView: View {
    @EnvironmentObject private var environment: AppEnvironment
    @State private var serverURLString: String = ""
    @State private var revoking = false

    var appVersion: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
        return "\(version) (\(build))"
    }

    var body: some View {
        Form {
            Section("Device") {
                LabeledContent("Label", value: environment.deviceLabel ?? "—")
                LabeledContent("Device id", value: environment.deviceId ?? "—")
                LabeledContent("App version", value: appVersion)
            }

            Section("Server") {
                TextField("https://dazbeez.com", text: $serverURLString)
                    .textInputAutocapitalization(.never)
                    .keyboardType(.URL)
                Button("Save server URL") {
                    if let url = URL(string: serverURLString.trimmingCharacters(in: .whitespacesAndNewlines)) {
                        environment.updateServerURL(url)
                    }
                }
            }

            Section {
                Button(role: .destructive) {
                    Task { await revoke() }
                } label: {
                    HStack {
                        Text(revoking ? "Revoking…" : "Revoke this device")
                        Spacer()
                        if revoking { ProgressView() }
                    }
                }
                .disabled(revoking)
            }

            Section("Privacy") {
                Link("Privacy policy", destination: URL(string: "https://dazbeez.com/privacy")!)
            }
        }
        .navigationTitle("Settings")
        .onAppear {
            serverURLString = environment.serverURL.absoluteString
        }
    }

    private func revoke() async {
        revoking = true
        defer { revoking = false }
        try? await environment.apiClient.revokeSelf()
        environment.clearToken()
    }
}
