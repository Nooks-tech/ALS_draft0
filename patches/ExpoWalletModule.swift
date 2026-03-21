import ExpoModulesCore
import ObjectiveC
import PassKit
import UIKit

/// Native `PKAddPassButton` (Apple's required control for "Add to Apple Wallet" UI).
class AppleWalletAddPassButtonView: ExpoView {
    let onWalletButtonPress = EventDispatcher()
    private let passButton: PKAddPassButton

    required init(appContext: AppContext? = nil) {
        passButton = PKAddPassButton(addPassButtonStyle: .black)
        super.init(appContext: appContext)
        clipsToBounds = true
        passButton.addTarget(self, action: #selector(handleWalletButtonPress), for: .touchUpInside)
        addSubview(passButton)
    }

    @objc private func handleWalletButtonPress() {
        onWalletButtonPress([:])
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let size = passButton.intrinsicContentSize
        let maxW = bounds.width > 0 ? bounds.width : size.width
        let w = min(size.width, maxW)
        let h = size.height
        passButton.frame = CGRect(
            x: (bounds.width - w) / 2,
            y: (bounds.height - h) / 2,
            width: w,
            height: h
        )
    }
}

public class ExpoWalletModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoWallet")

        View(AppleWalletAddPassButtonView.self) {
            Events("onWalletButtonPress")
        }

        AsyncFunction("addPass") { (value: String, promise: Promise) in
            guard PKPassLibrary.isPassLibraryAvailable() else {
                promise.reject(Exception(name: "E_PASS_LIBRARY_UNAVAILABLE", description: "Pass library unavailable"))
                return
            }

            guard let passData = Data(base64Encoded: value, options: .ignoreUnknownCharacters) else {
                promise.reject(Exception(name: "E_PASS_LIBRARY_INVALID_DATA", description: "Could not decode pass data"))
                return
            }

            let pass: PKPass
            do {
                pass = try PKPass(data: passData)
            } catch {
                let nsErr = error as NSError
                let detail = "domain=\(nsErr.domain) code=\(nsErr.code) \(nsErr.localizedDescription)"
                promise.reject(Exception(name: "E_PASS_LIBRARY_GENERIC", description: "Invalid pass: \(detail)"))
                return
            }

            DispatchQueue.main.async {
                guard let rootVC = UIApplication.shared.connectedScenes
                    .compactMap({ ($0 as? UIWindowScene)?.windows.first?.rootViewController })
                    .first else {
                    promise.reject(Exception(name: "E_PASS_LIBRARY_GENERIC", description: "No root view controller"))
                    return
                }

                let addController = PKAddPassesViewController(pass: pass)
                if let addController = addController {
                    let wrapper = WalletPassDelegate(promise: promise)
                    addController.delegate = wrapper
                    objc_setAssociatedObject(addController, "delegateRef", wrapper, .OBJC_ASSOCIATION_RETAIN_NONATOMIC)
                    rootVC.present(addController, animated: true, completion: nil)
                } else {
                    promise.reject(Exception(name: "E_PASS_LIBRARY_GENERIC", description: "Could not create PKAddPassesViewController"))
                }
            }
        }

        AsyncFunction("isAvailable") { (promise: Promise) in
            promise.resolve(PKPassLibrary.isPassLibraryAvailable())
        }
    }
}

class WalletPassDelegate: NSObject, PKAddPassesViewControllerDelegate {
    private let promise: Promise
    private var resolved = false

    init(promise: Promise) {
        self.promise = promise
        super.init()
    }

    func addPassesViewControllerDidFinish(_ controller: PKAddPassesViewController) {
        controller.dismiss(animated: true) { [weak self] in
            guard let self = self, !self.resolved else { return }
            self.resolved = true
            self.promise.resolve(true)
        }
    }
}
