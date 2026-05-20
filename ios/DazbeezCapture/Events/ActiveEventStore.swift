import Foundation

/// Persists the active event (used for business-card capture) in
/// `UserDefaults`. The active event applies to every subsequent business-card
/// scan until the user changes or clears it.
struct ActiveEventStore {
    private let key = "active_event_v1"

    func read() -> ActiveEvent? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ActiveEvent.self, from: data)
    }

    func write(_ event: ActiveEvent?) {
        guard let event else {
            UserDefaults.standard.removeObject(forKey: key)
            return
        }
        if let data = try? JSONEncoder().encode(event) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }
}
