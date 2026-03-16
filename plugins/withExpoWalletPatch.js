/**
 * Expo config plugin that patches @giulio987/expo-wallet Swift module
 * to use PKAddPassesViewController (native "Add to Wallet" sheet)
 * and include real iOS error messages in rejections.
 */
const { withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PATCHED_SWIFT = `import ExpoModulesCore
import PassKit
import UIKit

public class ExpoWalletModule: Module {
    public func definition() -> ModuleDefinition {
        Name("ExpoWallet")

        AsyncFunction("addPass") { (value: String, promise: Promise) in
            guard PKPassLibrary.isPassLibraryAvailable() else {
                promise.reject(Exception(name: "E_PASS_LIBRARY_UNAVAILABLE", description: "Pass library unavailable"))
                return
            }

            guard let passData = Data(base64Encoded: value, options: .ignoreUnknownCharacters) else {
                promise.reject(Exception(name: "E_PASS_LIBRARY_INVALID_DATA", description: "Could not decode base64 pass data"))
                return
            }

            let pass: PKPass
            do {
                pass = try PKPass(data: passData)
            } catch {
                let nsErr = error as NSError
                let detail = "domain=\\(nsErr.domain) code=\\(nsErr.code) \\(nsErr.localizedDescription)"
                promise.reject(Exception(name: "E_PASS_LIBRARY_GENERIC", description: "Invalid pass: \\(detail)"))
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
`;

function withExpoWalletPatch(config) {
  return withDangerousMod(config, [
    'ios',
    async (cfg) => {
      const podsDir = path.join(cfg.modRequest.platformProjectRoot, 'Pods');
      const targetPath = path.join(
        podsDir,
        'ExpoWallet',
        'ios',
        'ExpoWalletModule.swift'
      );

      const altPaths = [
        path.join(cfg.modRequest.platformProjectRoot, '..', 'node_modules', '@giulio987', 'expo-wallet', 'ios', 'ExpoWalletModule.swift'),
      ];

      for (const p of [targetPath, ...altPaths]) {
        if (fs.existsSync(p)) {
          console.log(`[withExpoWalletPatch] Patching: ${p}`);
          fs.writeFileSync(p, PATCHED_SWIFT, 'utf-8');
        }
      }

      return cfg;
    },
  ]);
}

module.exports = withExpoWalletPatch;
