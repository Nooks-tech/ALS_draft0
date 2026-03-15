Pod::Spec.new do |s|
  s.name           = 'ExpoPasskit'
  s.version        = '1.0.0'
  s.summary        = 'Native Apple Wallet PassKit integration for Expo'
  s.description    = 'Presents the native PKAddPassesViewController to add passes to Apple Wallet'
  s.author         = 'Nooks'
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'
  s.frameworks = 'PassKit'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
