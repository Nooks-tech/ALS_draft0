# Maps (delivery address & tracking)

## Select Delivery Location — blank white area

- **iOS:** The app uses **Apple Maps** (default `MapView` provider). If you previously saw only a white rectangle while using `PROVIDER_GOOGLE` everywhere, that was usually a missing or misconfigured **Google Maps iOS SDK** / API key. That is fixed by not forcing Google on iOS.
- **Android:** The app uses **Google Maps**. You need:
  - `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` (or `GOOGLE_MAPS_API_KEY`) in the EAS build env / `.env` so `app.config.js` can pass it into `android.config.googleMaps.apiKey`.
  - In [Google Cloud Console](https://console.cloud.google.com/): enable **Maps SDK for Android**, enable billing if required, and restrict the key to your app’s package name + SHA-1 as needed.

## Still blank on Android?

1. Rebuild the app after changing the API key (native config).
2. Confirm the key works with **Maps SDK for Android** (not only Geocoding).
3. Check Logcat for Google Maps errors when opening the screen.
