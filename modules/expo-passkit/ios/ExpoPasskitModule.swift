import ExpoModulesCore
import PassKit
import UIKit

public class ExpoPasskitModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoPasskit")

    Function("canAddPasses") { () -> Bool in
      return PKAddPassesViewController.canAddPasses()
    }

    AsyncFunction("addPass") { (base64: String, promise: Promise) in
      guard let data = Data(base64Encoded: base64, options: .ignoreUnknownCharacters) else {
        promise.reject("ERR_INVALID_DATA", "Could not decode base64 pass data")
        return
      }

      let pass: PKPass
      do {
        pass = try PKPass(data: data)
      } catch {
        promise.reject("ERR_INVALID_PASS", "Invalid pass: \(error.localizedDescription)")
        return
      }

      DispatchQueue.main.async {
        guard let vc = PKAddPassesViewController(pass: pass) else {
          promise.reject("ERR_NO_CONTROLLER", "Could not create Add Pass controller")
          return
        }

        guard let rootVC = ExpoPasskitModule.topViewController() else {
          promise.reject("ERR_NO_ROOT_VC", "Could not find root view controller")
          return
        }

        rootVC.present(vc, animated: true) {
          promise.resolve(true)
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
