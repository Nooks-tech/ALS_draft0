import ExpoModulesCore
import PassKit
import UIKit

public class ExpoPasskitModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoPasskit")

    Function("canAddPasses") { () -> Bool in
      return PKAddPassesViewController.canAddPasses()
    }

    AsyncFunction("addPass") { (base64: String) in
      guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
        throw PasskitError.invalidData
      }

      let pass: PKPass
      do {
        pass = try PKPass(data: data)
      } catch {
        throw PasskitError.invalidPass(error.localizedDescription)
      }

      return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Bool, Error>) in
        DispatchQueue.main.async {
          guard let vc = PKAddPassesViewController(pass: pass) else {
            continuation.resume(throwing: PasskitError.noController)
            return
          }

          guard let rootVC = Self.topViewController() else {
            continuation.resume(throwing: PasskitError.noRootVC)
            return
          }

          rootVC.present(vc, animated: true) {
            continuation.resume(returning: true)
          }
        }
      }
    }
  }

  private static func topViewController() -> UIViewController? {
    let scene = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .first { $0.activationState == .foregroundActive }
    guard let root = scene?.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
      return nil
    }
    var top = root
    while let presented = top.presentedViewController {
      top = presented
    }
    return top
  }
}

enum PasskitError: Error, LocalizedError {
  case invalidData
  case invalidPass(String)
  case noController
  case noRootVC

  var errorDescription: String? {
    switch self {
    case .invalidData:
      return "Could not decode base64 pass data"
    case .invalidPass(let detail):
      return "Invalid pass: \(detail)"
    case .noController:
      return "Could not create Add Pass controller"
    case .noRootVC:
      return "Could not find root view controller"
    }
  }
}
