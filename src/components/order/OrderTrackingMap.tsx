import Constants from 'expo-constants';
import { Platform, StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, Polyline, PROVIDER_GOOGLE } from 'react-native-maps';
import { useTranslation } from 'react-i18next';

const DEFAULT_ACCENT = '#0D9488';

type OrderTrackingMapProps = {
  branchLat: number;
  branchLon: number;
  deliveryLat?: number;
  deliveryLng?: number;
  driverLat?: number;
  driverLon?: number;
  branchName?: string;
  /** Merchant accent color for "Your location" pin (default teal) */
  accentColor?: string;
  /** ETA string from OTO, if present (e.g. "15 min", "14:32"). */
  etaLabel?: string | null;
};

const MAP_HEIGHT = 264;

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = (v: number) => (v * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function OrderTrackingMap({
  branchLat,
  branchLon,
  deliveryLat,
  deliveryLng,
  driverLat,
  driverLon,
  branchName,
  accentColor = DEFAULT_ACCENT,
  etaLabel = null }: OrderTrackingMapProps) {
  const { i18n } = useTranslation();
  const runtimeGoogleMapsKey = (
    (Constants.expoConfig?.extra as { googleMapsApiKey?: string } | undefined)?.googleMapsApiKey
    || (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY)
    || ''
  ).trim();
  const hasGoogleMapsKey = runtimeGoogleMapsKey.length > 0;
  const shouldRenderNativeMap = Platform.OS === 'ios' || hasGoogleMapsKey;
  const mapProvider = Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined;
  const hasDelivery = deliveryLat != null && deliveryLng != null;
  const hasDriver = driverLat != null && driverLon != null;
  const isArabic = i18n.language === 'ar';

  // Show how far the driver is from the customer so the user sees something
  // useful even when OTO doesn't send an ETA string.
  const driverDistanceKm =
    hasDriver && hasDelivery
      ? haversineKm(Number(driverLat), Number(driverLon), Number(deliveryLat), Number(deliveryLng))
      : null;
  const distanceLabel = driverDistanceKm == null
    ? null
    : driverDistanceKm < 1
      ? (isArabic ? 'أقل من كيلومتر' : 'Less than 1 km')
      : `${driverDistanceKm.toFixed(1)} ${isArabic ? 'كم' : 'km'}`;

  const points = [
    { lat: branchLat, lng: branchLon },
    ...(hasDelivery ? [{ lat: deliveryLat!, lng: deliveryLng! }] : []),
    ...(hasDriver ? [{ lat: driverLat!, lng: driverLon! }] : []),
  ];

  const centerLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const centerLng = points.reduce((s, p) => s + p.lng, 0) / points.length;
  const padding = 0.01;
  const minLat = Math.min(...points.map((p) => p.lat)) - padding;
  const maxLat = Math.max(...points.map((p) => p.lat)) + padding;
  const minLng = Math.min(...points.map((p) => p.lng)) - padding;
  const maxLng = Math.max(...points.map((p) => p.lng)) + padding;
  const latDelta = Math.max(maxLat - minLat, 0.02);
  const lngDelta = Math.max(maxLng - minLng, 0.02);

  if (!shouldRenderNativeMap) {
    return (
      <View style={[styles.container, { height: MAP_HEIGHT, padding: 16, justifyContent: 'center' }]}>
        <Text style={{ color: '#0f172a', fontWeight: '700', marginBottom: 8 }}>{isArabic ? 'خريطة التتبع المباشر غير متاحة' : 'Live tracking map unavailable'}</Text>
        <Text style={{ color: '#475569' }}>
          {isArabic ? 'الفرع' : 'Branch'}: {branchLat.toFixed(5)}, {branchLon.toFixed(5)}
        </Text>
        {hasDelivery ? (
          <Text style={{ color: '#475569', marginTop: 4 }}>
            {isArabic ? 'التوصيل' : 'Delivery'}: {deliveryLat!.toFixed(5)}, {deliveryLng!.toFixed(5)}
          </Text>
        ) : null}
        {hasDriver ? (
          <Text style={{ color: '#475569', marginTop: 4 }}>
            {isArabic ? 'السائق' : 'Driver'}: {driverLat!.toFixed(5)}, {driverLon!.toFixed(5)}
          </Text>
        ) : null}
      </View>
    );
  }

  return (
    <View>
      <View style={[styles.container, { height: MAP_HEIGHT }]}>
        <MapView
          style={StyleSheet.absoluteFill}
          provider={mapProvider}
          loadingEnabled
          initialRegion={{
            latitude: centerLat,
            longitude: centerLng,
            latitudeDelta: latDelta,
            longitudeDelta: lngDelta }}
          showsUserLocation={false}
          showsMyLocationButton={false}
        >
          <Marker
            coordinate={{ latitude: branchLat, longitude: branchLon }}
            title={isArabic ? 'الفرع' : 'Branch'}
            description={branchName}
            pinColor="#F59E0B"
          />
          {hasDelivery && (
            <Marker
              coordinate={{ latitude: deliveryLat, longitude: deliveryLng }}
              title={isArabic ? 'موقعك' : 'Your location'}
              description={isArabic ? 'عنوان التوصيل' : 'Delivery address'}
              pinColor={accentColor}
            />
          )}
          {hasDriver && (
            <Marker
              coordinate={{ latitude: driverLat, longitude: driverLon }}
              title={isArabic ? 'السائق' : 'Driver'}
              description={isArabic ? 'في الطريق' : 'On the way'}
              pinColor="#6366F1"
            />
          )}
          {/* Straight-line polyline between driver and customer. We don't have
              a real route from OTO so this is purely directional. */}
          {hasDriver && hasDelivery && (
            <Polyline
              coordinates={[
                { latitude: Number(driverLat), longitude: Number(driverLon) },
                { latitude: Number(deliveryLat), longitude: Number(deliveryLng) },
              ]}
              strokeColor={accentColor}
              strokeWidth={3}
              lineDashPattern={[6, 6]}
            />
          )}
        </MapView>
      </View>
      {(etaLabel || distanceLabel) && (
        <View
          style={{
            marginTop: 12,
            padding: 14,
            borderRadius: 16,
            backgroundColor: `${accentColor}15`,
            flexDirection: 'row',
            justifyContent: 'space-between',
            alignItems: 'center' }}
        >
          <View>
            <Text style={{ color: '#475569', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' }}>
              {isArabic ? 'الوقت المتوقع' : 'Estimated arrival'}
            </Text>
            <Text style={{ color: accentColor, fontSize: 22, fontWeight: '800', marginTop: 2 }}>
              {etaLabel || (isArabic ? 'قريباً' : 'Shortly')}
            </Text>
          </View>
          {distanceLabel && (
            <View style={{ alignItems: 'flex-end' }}>
              <Text style={{ color: '#475569', fontSize: 11, fontWeight: '700', letterSpacing: 1, textTransform: 'uppercase' }}>
                {isArabic ? 'بُعد السائق' : 'Driver distance'}
              </Text>
              <Text style={{ color: '#0f172a', fontSize: 18, fontWeight: '700', marginTop: 2 }}>
                {distanceLabel}
              </Text>
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9' } });
