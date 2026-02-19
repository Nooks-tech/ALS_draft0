import { Dimensions, StyleSheet, View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';

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

const MAP_HEIGHT = 220;

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
  const hasDelivery = deliveryLat != null && deliveryLng != null;
  const hasDriver = driverLat != null && driverLon != null;

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

  return (
    <View style={[styles.container, { height: MAP_HEIGHT }]}>
      <MapView
        provider={PROVIDER_GOOGLE}
        style={StyleSheet.absoluteFill}
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
          title="Branch"
          description={branchName}
          pinColor="#F59E0B"
        />
        {hasDelivery && (
          <Marker
            coordinate={{ latitude: deliveryLat, longitude: deliveryLng }}
            title="Your location"
            description="Delivery address"
            pinColor={accentColor}
          />
        )}
        {hasDriver && (
          <Marker
            coordinate={{ latitude: driverLat, longitude: driverLon }}
            title="Driver"
            description="On the way"
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
