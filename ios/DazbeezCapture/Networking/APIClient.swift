import Foundation

/// HTTP client targeting the `/api/mobile/*` namespace. Bearer token is
/// fetched per request so token rotation in `AppEnvironment` propagates
/// without reconstructing the client.
struct APIClient {
    let baseURL: URL
    let tokenProvider: () -> String?

    private var session: URLSession {
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = true
        config.timeoutIntervalForRequest = 30
        config.timeoutIntervalForResource = 5 * 60
        return URLSession(configuration: config)
    }

    // MARK: - Pairing (unauthenticated)

    struct StartPairingResponse: Decodable {
        let code: String
        let expiresAt: String
    }

    struct CheckPairingResponse: Decodable {
        let ready: Bool?
        let expired: Bool?
        let bearerToken: String?
        let deviceId: String?
    }

    func startPairing() async throws -> StartPairingResponse {
        let request = makeRequest(path: "/api/mobile/auth/start-pairing", method: "POST", authenticated: false)
        return try await send(request)
    }

    func checkPairing(code: String) async throws -> CheckPairingResponse {
        var components = URLComponents(url: baseURL.appendingPathComponent("/api/mobile/auth/check"), resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "code", value: code)]
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        return try await send(request)
    }

    // MARK: - Authenticated

    struct MeResponse: Decodable {
        let deviceId: String
        let actor: String
        let scopes: [String]
        let label: String?
        let appVersion: String?
        let platform: String?
        let lastSeenAt: String?
    }

    func fetchMe() async throws -> MeResponse {
        let request = makeRequest(path: "/api/mobile/me", method: "GET", authenticated: true)
        return try await send(request)
    }

    func revokeSelf() async throws {
        let request = makeRequest(path: "/api/mobile/auth/revoke", method: "POST", authenticated: true)
        let (_, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.badStatus
        }
    }

    // MARK: - Uploads

    struct ReceiptUploadResult: Decodable {
        let ok: Bool
        let duplicate: Bool
        let receiptId: String
        let reviewUrl: String?
    }

    struct BusinessCardUploadResult: Decodable {
        let ok: Bool
        let duplicate: Bool
        let batchId: Int
        let batchCardId: Int
        let businessCardImageId: Int
        let reviewUrl: String?
    }

    func uploadReceipt(jpeg: Data, fields: ReceiptUploadFields) async throws -> ReceiptUploadResult {
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = makeRequest(path: "/api/mobile/receipts/upload", method: "POST", authenticated: true)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = MultipartBuilder.build(boundary: boundary, parts: fields.parts(jpeg: jpeg))
        return try await send(request)
    }

    func uploadBusinessCard(jpeg: Data, fields: BusinessCardUploadFields) async throws -> BusinessCardUploadResult {
        let boundary = "Boundary-\(UUID().uuidString)"
        var request = makeRequest(path: "/api/mobile/business-cards/upload", method: "POST", authenticated: true)
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = MultipartBuilder.build(boundary: boundary, parts: fields.parts(jpeg: jpeg))
        return try await send(request)
    }

    // MARK: - Internals

    private func makeRequest(path: String, method: String, authenticated: Bool) -> URLRequest {
        let url = baseURL.appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if authenticated, let token = tokenProvider() {
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return request
    }

    private func send<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw APIError.badResponse }
        if !(200..<300).contains(http.statusCode) {
            throw APIError.serverError(status: http.statusCode, body: data)
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

enum APIError: Error {
    case badResponse
    case badStatus
    case serverError(status: Int, body: Data)
}

struct ReceiptUploadFields {
    let clientCaptureId: String
    let capturedAtClient: Date
    let paymentHint: String?     // "AMEX" | "CASH" | nil
    let note: String?
    let appVersion: String

    func parts(jpeg: Data) -> [MultipartBuilder.Part] {
        var parts: [MultipartBuilder.Part] = [
            .file(name: "file", filename: "\(clientCaptureId).jpg", contentType: "image/jpeg", data: jpeg),
            .text(name: "client_capture_id", value: clientCaptureId),
            .text(name: "captured_at_client", value: ISO8601DateFormatter().string(from: capturedAtClient)),
            .text(name: "app_version", value: appVersion),
        ]
        if let hint = paymentHint { parts.append(.text(name: "payment_hint", value: hint)) }
        if let note = note { parts.append(.text(name: "note", value: note)) }
        return parts
    }
}

struct BusinessCardUploadFields {
    let clientCaptureId: String
    let capturedAtClient: Date
    let eventName: String?
    let batchId: Int?
    let note: String?
    let appVersion: String

    func parts(jpeg: Data) -> [MultipartBuilder.Part] {
        var parts: [MultipartBuilder.Part] = [
            .file(name: "file", filename: "\(clientCaptureId).jpg", contentType: "image/jpeg", data: jpeg),
            .text(name: "client_capture_id", value: clientCaptureId),
            .text(name: "captured_at_client", value: ISO8601DateFormatter().string(from: capturedAtClient)),
            .text(name: "app_version", value: appVersion),
        ]
        if let event = eventName { parts.append(.text(name: "event_name", value: event)) }
        if let batchId = batchId { parts.append(.text(name: "batch_id", value: String(batchId))) }
        if let note = note { parts.append(.text(name: "note", value: note)) }
        return parts
    }
}

enum MultipartBuilder {
    enum Part {
        case text(name: String, value: String)
        case file(name: String, filename: String, contentType: String, data: Data)
    }

    static func build(boundary: String, parts: [Part]) -> Data {
        var body = Data()
        let line = "\r\n"
        for part in parts {
            body.append("--\(boundary)\(line)".data(using: .utf8)!)
            switch part {
            case .text(let name, let value):
                body.append("Content-Disposition: form-data; name=\"\(name)\"\(line)\(line)".data(using: .utf8)!)
                body.append("\(value)\(line)".data(using: .utf8)!)
            case .file(let name, let filename, let contentType, let data):
                body.append(
                    "Content-Disposition: form-data; name=\"\(name)\"; filename=\"\(filename)\"\(line)"
                        .data(using: .utf8)!)
                body.append("Content-Type: \(contentType)\(line)\(line)".data(using: .utf8)!)
                body.append(data)
                body.append("\(line)".data(using: .utf8)!)
            }
        }
        body.append("--\(boundary)--\(line)".data(using: .utf8)!)
        return body
    }
}
