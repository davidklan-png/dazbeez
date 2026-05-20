import SwiftUI

struct EventPickerView: View {
    @EnvironmentObject private var environment: AppEnvironment
    @Environment(\.dismiss) private var dismiss
    @State private var eventName: String = ""

    var body: some View {
        Form {
            Section("Active event") {
                if let event = environment.activeEvent {
                    HStack {
                        Text(event.name)
                        Spacer()
                        Button("Clear", role: .destructive) {
                            environment.setActiveEvent(nil)
                            dismiss()
                        }
                    }
                } else {
                    Text("No active event").foregroundStyle(.secondary)
                }
            }
            Section("Start a new event") {
                TextField("Event name (e.g. AI Tokyo Mixer 2026-05)", text: $eventName)
                Button("Use this event") {
                    let trimmed = eventName.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !trimmed.isEmpty else { return }
                    environment.setActiveEvent(ActiveEvent(id: nil, name: trimmed, createdAtClient: Date()))
                    dismiss()
                }
                .disabled(eventName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .navigationTitle("Event")
    }
}
