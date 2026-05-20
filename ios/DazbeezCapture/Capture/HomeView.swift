import SwiftUI

struct HomeView: View {
    @EnvironmentObject private var environment: AppEnvironment
    @State private var captureMode: CaptureMode = .receipt

    enum CaptureMode { case receipt, businessCard }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                Picker("Mode", selection: $captureMode) {
                    Text("Receipt").tag(CaptureMode.receipt)
                    Text("Business card").tag(CaptureMode.businessCard)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal)

                NavigationLink {
                    captureMode == .receipt
                        ? AnyView(ReceiptCaptureView())
                        : AnyView(BusinessCardCaptureView())
                } label: {
                    Text(captureMode == .receipt ? "Capture Receipt" : "Capture Business Card")
                        .font(.title2.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 80)
                        .padding()
                        .background(Color.yellow.opacity(0.2))
                        .clipShape(RoundedRectangle(cornerRadius: 20))
                }
                .padding(.horizontal)

                if captureMode == .businessCard {
                    EventBannerView()
                }

                Spacer()

                NavigationLink("Upload queue") { UploadQueueView() }
                NavigationLink("Settings") { SettingsView() }
            }
            .padding(.vertical)
            .navigationTitle("Dazbeez Capture")
        }
    }
}

/// Placeholders so the scaffold compiles before the M2 work fleshes them out.

struct ReceiptCaptureView: View {
    var body: some View {
        Text("Receipt capture (M2)")
            .navigationTitle("Receipt")
    }
}

struct BusinessCardCaptureView: View {
    var body: some View {
        Text("Business card capture (M2)")
            .navigationTitle("Business card")
    }
}

struct UploadQueueView: View {
    var body: some View {
        Text("Upload queue (M3)")
            .navigationTitle("Queue")
    }
}

struct EventBannerView: View {
    @EnvironmentObject private var environment: AppEnvironment

    var body: some View {
        Group {
            if let event = environment.activeEvent {
                NavigationLink {
                    EventPickerView()
                } label: {
                    HStack {
                        Image(systemName: "calendar")
                        Text("Active event: \(event.name)")
                            .lineLimit(1)
                        Spacer()
                        Text("Change")
                            .foregroundStyle(.tint)
                    }
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding(.horizontal)
                }
            } else {
                NavigationLink {
                    EventPickerView()
                } label: {
                    Text("Choose or create an event to scan into")
                        .padding()
                        .frame(maxWidth: .infinity)
                        .background(Color.orange.opacity(0.15))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.horizontal)
                }
            }
        }
    }
}
