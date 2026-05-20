import SwiftUI

struct PairingView: View {
    @EnvironmentObject private var environment: AppEnvironment
    @StateObject private var viewModel = PairingViewModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                Spacer()
                Image(systemName: "iphone.gen3.circle.fill")
                    .font(.system(size: 72))
                    .foregroundStyle(.tint)
                Text("Pair with Dazbeez")
                    .font(.title.bold())
                Text("Open /receipts/pair in Safari on a signed-in browser and enter the code below.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal)

                if let code = viewModel.code {
                    Text(code)
                        .font(.system(size: 40, weight: .semibold, design: .monospaced))
                        .padding(.horizontal, 24)
                        .padding(.vertical, 12)
                        .background(Color.yellow.opacity(0.2))
                        .clipShape(RoundedRectangle(cornerRadius: 16))
                } else {
                    ProgressView()
                }

                if let message = viewModel.statusMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Button(action: { Task { await viewModel.startNewCode() } }) {
                    Text("Generate new code")
                        .frame(maxWidth: .infinity)
                        .padding()
                }
                .buttonStyle(.bordered)
                .padding(.horizontal)
            }
            .navigationTitle("")
            .navigationBarHidden(true)
            .task {
                viewModel.attach(environment: environment)
                await viewModel.startNewCode()
            }
            .onDisappear { viewModel.stopPolling() }
        }
    }
}

@MainActor
final class PairingViewModel: ObservableObject {
    @Published var code: String?
    @Published var statusMessage: String?
    private var environment: AppEnvironment?
    private var pollTask: Task<Void, Never>?

    func attach(environment: AppEnvironment) {
        self.environment = environment
    }

    func startNewCode() async {
        guard let environment else { return }
        stopPolling()
        statusMessage = "Requesting a pairing code…"
        do {
            let response = try await environment.apiClient.startPairing()
            code = response.code
            statusMessage = "Waiting for the browser confirmation…"
            startPolling()
        } catch {
            statusMessage = "Could not request a code. Tap to retry."
        }
    }

    func startPolling() {
        guard let environment, let code else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 2_000_000_000)
                if Task.isCancelled { return }
                guard let result = try? await environment.apiClient.checkPairing(code: code) else { continue }
                if result.expired == true {
                    await MainActor.run {
                        self?.statusMessage = "Code expired. Tap below for a new one."
                    }
                    return
                }
                if result.ready == true, let token = result.bearerToken, let deviceId = result.deviceId {
                    await MainActor.run {
                        environment.saveToken(token, deviceId: deviceId)
                        self?.statusMessage = "Paired!"
                    }
                    return
                }
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }
}
