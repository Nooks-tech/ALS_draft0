import Constants from 'expo-constants';
import { StyleSheet, Text, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
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
};

const MAP_HEIGHT = 264;

export function OrderTrackingMap({
  branchLat,
  branchLon,
  deliveryLat,
  deliveryLng,
  driverLat,
  driverLon,
  branchName,
  accentColor = DEFAULT_ACCENT,
}: OrderTrackingMapProps) {
  const { i18n } = useTranslation();
  const runtimeGoogleMapsKey =
    ((Constants.expoConfig?.extra as { googleMapsApiKey?: string } | undefined)?.googleMapsApiKey || '').trim();
  const shouldRenderNativeMap = runtimeGoogleMapsKey.length > 0;
  const hasDelivery = deliveryLat != null && deliveryLng != null;
  const hasDriver = driverLat != null && driverLon != null;
  const isArabic = i18n.language === 'ar';

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
    <View style={[styles.container, { height: MAP_HEIGHT }]}>
      <MapView
        style={StyleSheet.absoluteFill}
        provider={PROVIDER_GOOGLE}
        initialRegion={{
          latitude: centerLat,
          longitude: centerLng,
          latitudeDelta: latDelta,
          longitudeDelta: lngDelta,
        }}
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
      </MapView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: 16,
    overflow: 'hidden',
    backgroundColor: '#f1f5f9',
  },
});
