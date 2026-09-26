import ExpoModulesCore
import Foundation
import LocalAuthentication
import Security

// The iOS device key. A P-256 private key created by the Security framework in the
// Secure Enclave when the device has one (otherwise in the keychain), with an access control that
// requires the currently enrolled Face ID / Touch ID for every use. The private key cannot be
// exported; JavaScript only ever receives the public key and DER signatures.

// Each pairing has its own immutable key, tagged with its device id, so a signature can always be
// attributed to the exact key that made it. Pair and sign run one at a time on this queue.
private let recordKey = "ai.fulcra.device-key.record"
private let deviceKeyQueue = DispatchQueue(label: "ai.fulcra.device-key")

private func keyTag(_ deviceId: String) -> Data {
  return "ai.fulcra.device-key.\(deviceId)".data(using: .utf8)!
}

private func currentRecord() -> [String: Any]? {
  return UserDefaults.standard.dictionary(forKey: recordKey)
}
// DER SubjectPublicKeyInfo prefix for an uncompressed P-256 point.
private let p256SpkiHeader: [UInt8] = [
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
]

private func biometricsAvailable() -> Bool {
  var error: NSError?
  return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
}

private func secureEnclaveAvailable() -> Bool {
  #if targetEnvironment(simulator)
    return false
  #else
    if #available(iOS 13.0, *) {
      return true
    }
    return false
  #endif
}

private func keyStorage(secureEnclave: Bool) -> String {
  return secureEnclave ? "secure-enclave" : "keychain-biometric"
}

private func privateKeyQuery(deviceId: String, context: LAContext?) -> [String: Any] {
  var query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: keyTag(deviceId),
    kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
    kSecReturnRef as String: true,
  ]
  if let context = context {
    query[kSecUseAuthenticationContext as String] = context
  }
  return query
}

private func deleteKey(_ deviceId: String) {
  let query: [String: Any] = [
    kSecClass as String: kSecClassKey,
    kSecAttrApplicationTag as String: keyTag(deviceId),
  ]
  SecItemDelete(query as CFDictionary)
}

private func isCancel(_ error: Error?) -> Bool {
  guard let error = error as NSError? else { return false }
  if error.domain == LAErrorDomain {
    return [LAError.userCancel.rawValue, LAError.appCancel.rawValue, LAError.systemCancel.rawValue,
            LAError.userFallback.rawValue, LAError.authenticationFailed.rawValue].contains(error.code)
  }
  return error.code == Int(errSecUserCanceled) || error.code == Int(errSecAuthFailed)
}

public class PaseoDeviceKeyModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoDeviceKey")

    AsyncFunction("status") { () -> [String: Any] in
      let record = deviceKeyQueue.sync { currentRecord() }
      // Reading attributes (not the key's use) never prompts.
      var present = false
      if let deviceId = record?["deviceId"] as? String {
        var attributes: CFTypeRef?
        let query: [String: Any] = [
          kSecClass as String: kSecClassKey,
          kSecAttrApplicationTag as String: keyTag(deviceId),
          kSecReturnAttributes as String: true,
        ]
        present = SecItemCopyMatching(query as CFDictionary, &attributes) == errSecSuccess
      }
      if present, let record = record {
        return [
          "paired": true,
          "deviceId": record["deviceId"] ?? "",
          "publicKey": record["publicKey"] ?? "",
          "keyStorage": record["keyStorage"] ?? "keychain-biometric",
          "userPresence": true,
        ]
      }
      return [
        "paired": false,
        "keyStorage": keyStorage(secureEnclave: secureEnclaveAvailable()),
        "userPresence": biometricsAvailable(),
      ]
    }

    // Asks for Face ID / Touch ID first; only then creates the key.
    AsyncFunction("pair") { (reason: String, promise: Promise) in
      guard biometricsAvailable() else {
        promise.reject("E_NO_BIOMETRICS", "Set up Face ID or Touch ID to pair this device")
        return
      }
      let context = LAContext()
      context.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) {
        success, error in
        guard success else {
          promise.reject(isCancel(error) ? "E_CANCELLED" : "E_FAILED", "Pairing was not confirmed")
          return
        }
        deviceKeyQueue.async {
          let previousId = currentRecord()?["deviceId"] as? String
          let deviceId = UUID().uuidString.lowercased()
          let secureEnclave = secureEnclaveAvailable()
          var flags: SecAccessControlCreateFlags = [.biometryCurrentSet]
          if secureEnclave { flags.insert(.privateKeyUsage) }
          var accessError: Unmanaged<CFError>?
          guard let access = SecAccessControlCreateWithFlags(
            nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, flags, &accessError)
          else {
            promise.reject("E_FAILED", "The key's access control could not be created")
            return
          }
          var attributes: [String: Any] = [
            kSecAttrKeyType as String: kSecAttrKeyTypeECSECPrimeRandom,
            kSecAttrKeySizeInBits as String: 256,
            kSecPrivateKeyAttrs as String: [
              kSecAttrIsPermanent as String: true,
              kSecAttrApplicationTag as String: keyTag(deviceId),
              kSecAttrAccessControl as String: access,
            ],
          ]
          if secureEnclave {
            attributes[kSecAttrTokenID as String] = kSecAttrTokenIDSecureEnclave
          }
          var createError: Unmanaged<CFError>?
          guard let privateKey = SecKeyCreateRandomKey(attributes as CFDictionary, &createError),
            let publicKey = SecKeyCopyPublicKey(privateKey),
            let point = SecKeyCopyExternalRepresentation(publicKey, nil) as Data?
          else {
            promise.reject("E_FAILED", "The device key could not be created")
            return
          }
          let spki = Data(p256SpkiHeader) + point
          let record: [String: Any] = [
            "deviceId": deviceId,
            "publicKey": spki.base64EncodedString(),
            "keyStorage": keyStorage(secureEnclave: secureEnclave),
          ]
          // The new key exists before the record points at it; the old key goes last.
          UserDefaults.standard.set(record, forKey: recordKey)
          if let previousId = previousId, previousId != deviceId { deleteKey(previousId) }
          promise.resolve(record.merging(["userPresence": true]) { current, _ in current })
        }
      }
    }

    // Signs the given bytes (base64) after Face ID / Touch ID; returns the DER ECDSA signature and
    // the device id of the key that made it.
    AsyncFunction("sign") { (dataBase64: String, reason: String, promise: Promise) in
      guard let data = Data(base64Encoded: dataBase64) else {
        promise.reject("E_INPUT", "Invalid data")
        return
      }
      // On the device-key queue: the record and the key it names are read together, and a pairing
      // cannot replace them until this signature is finished.
      deviceKeyQueue.async {
        guard let deviceId = currentRecord()?["deviceId"] as? String else {
          promise.reject("E_NOT_PAIRED", "This device is not paired")
          return
        }
        let context = LAContext()
        context.localizedReason = reason
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
          privateKeyQuery(deviceId: deviceId, context: context) as CFDictionary, &item)
        guard status == errSecSuccess, let key = item else {
          promise.reject("E_NOT_PAIRED", "This device is not paired")
          return
        }
        var signError: Unmanaged<CFError>?
        guard let signature = SecKeyCreateSignature(
          key as! SecKey, .ecdsaSignatureMessageX962SHA256, data as CFData, &signError) as Data?
        else {
          let error = signError?.takeRetainedValue() as Error?
          promise.reject(isCancel(error) ? "E_CANCELLED" : "E_FAILED", "Nothing was signed")
          return
        }
        // The identity of the exact key that signed.
        promise.resolve(["signature": signature.base64EncodedString(), "deviceId": deviceId])
      }
    }
  }
}
