import Foundation
import SwiftUI

/// Single source of truth for shared app state: server URL, current device
/// token, active event/batch, and the upload queue. Views read this via
/// `@EnvironmentObject` and route mutations back through `AppEnvironment`.
@MainActor
final class AppEnvironment: ObservableObject {
    @Published var serverURL: URL
    @Published var deviceToken: String?
    @Published var deviceLabel: String?
    @Published var deviceId: String?
    @Published var activeEvent: ActiveEvent?
    @Published private(set) var apiClient: APIClient

    private let tokenStore = KeychainTokenStore()
    private let eventStore = ActiveEventStore()

    init() {
        let defaultURL = URL(string: "https://dazbeez.com")!
        self.serverURL = defaultURL
        self.apiClient = APIClient(baseURL: defaultURL, tokenProvider: { nil })
    }

    func bootstrap() async {
        // Restore server URL from UserDefaults if previously set.
        if let stored = UserDefaults.standard.string(forKey: "server_url"),
           let url = URL(string: stored) {
            serverURL = url
        }
        deviceToken = tokenStore.read()
        activeEvent = eventStore.read()
        apiClient = APIClient(baseURL: serverURL, tokenProvider: { [weak self] in
            self?.deviceToken
        })
        if deviceToken != nil {
            await refreshDevice()
        }
    }

    func saveToken(_ token: String, deviceId: String) {
        tokenStore.write(token)
        self.deviceToken = token
        self.deviceId = deviceId
    }

    func clearToken() {
        tokenStore.delete()
        deviceToken = nil
        deviceId = nil
        deviceLabel = nil
    }

    func setActiveEvent(_ event: ActiveEvent?) {
        activeEvent = event
        eventStore.write(event)
    }

    func updateServerURL(_ url: URL) {
        serverURL = url
        UserDefaults.standard.set(url.absoluteString, forKey: "server_url")
        apiClient = APIClient(baseURL: url, tokenProvider: { [weak self] in
            self?.deviceToken
        })
    }

    func refreshDevice() async {
        guard let result = try? await apiClient.fetchMe() else { return }
        deviceId = result.deviceId
        deviceLabel = result.label
    }
}

struct ActiveEvent: Codable, Equatable {
    let id: Int?          // server-side batch_id once known
    let name: String
    let createdAtClient: Date
}
