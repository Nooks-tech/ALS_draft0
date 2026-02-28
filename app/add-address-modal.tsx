import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';
import { reverseGeocode } from '../src/api/mapbox';
import { useDeliveryAddress } from '../src/hooks/useDeliveryAddress';
import { useMapboxSearch } from '../src/hooks/useMapboxSearch';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useSavedAddresses, type SavedAddress } from '../src/context/SavedAddressesContext';
import { ArrowLeft, MapPin, Search } from 'lucide-react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import MapView, { Marker } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const MAP_HEIGHT = 200;
const LABELS: { value: SavedAddress['label']; icon: string }[] = [
  { value: 'Home', icon: '🏠' },
  { value: 'Work', icon: '💼' },
  { value: 'Other', icon: '📍' },
];

export default function AddAddressModal() {
  const router = useRouter();
  const { from, edit: editId } = useLocalSearchParams<{ from?: string; edit?: string }>();
  const insets = useSafeAreaInsets();
  const { primaryColor } = useMerchantBranding();
  const { addAddress, updateAddress, addresses } = useSavedAddresses();
  const { setDeliveryAddress } = useCart();
  const isDeliveryMode = from === 'delivery';
  const isEditMode = !!editId;
  const editingAddr = addresses.find((a) => a.id === editId);
  const { address, fetchCurrentLocation } = useDeliveryAddress();
  const [label, setLabel] = useState<SavedAddress['label']>('Home');
  const [customLabel, setCustomLabel] = useState('');
  const [manualAddressText, setManualAddressText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedMapboxAddr, setSelectedMapboxAddr] = useState<{ address: string; lat: number; lng: number } | null>(null);
  const [pinCoords, setPinCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [addressLoading, setAddressLoading] = useState(false);
  const runtimeGoogleMapsKey =
    ((Constants.expoConfig?.extra as { googleMapsApiKey?: string } | undefined)?.googleMapsApiKey || '').trim();
  const shouldRenderNativeMap = Platform.OS !== 'android' || runtimeGoogleMapsKey.length > 0;
  const mapRegion = useState({
    latitude: 24.7136,
    longitude: 46.6753,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02,
  })[0];
  const mapRef = useRef<MapView>(null);
  const { results: searchResults } = useMapboxSearch(searchQuery);

  useEffect(() => {
    if (editId && !editingAddr) return;
    if (editingAddr) {
      setLabel(editingAddr.label);
      setCustomLabel(editingAddr.customLabel || '');
      setManualAddressText(editingAddr.address);
      if (editingAddr.lat != null && editingAddr.lng != null) {
        setPinCoords({ lat: editingAddr.lat, lng: editingAddr.lng });
        mapRef.current?.animateToRegion({
          latitude: editingAddr.lat,
          longitude: editingAddr.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }, 400);
      }
      return;
    }
    setAddressLoading(true);
    fetchCurrentLocation().then((result) => {
      setAddressLoading(false);
      if (result?.lat != null && result?.lng != null) {
        setPinCoords({ lat: result.lat, lng: result.lng });
        setManualAddressText(result.address);
        mapRef.current?.animateToRegion({
          latitude: result.lat,
          longitude: result.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02,
        }, 400);
      }
    });
  }, [fetchCurrentLocation, editingAddr?.id]);

  const getAddressForSave = () => {
    if (selectedMapboxAddr) return selectedMapboxAddr;
    if (pinCoords) {
      return {
        address: manualAddressText.trim() || address?.address || `${pinCoords.lat.toFixed(6)}, ${pinCoords.lng.toFixed(6)}`,
        lat: pinCoords.lat,
        lng: pinCoords.lng,
      };
    }
    if (manualAddressText.trim()) return { address: manualAddressText.trim(), lat: undefined, lng: undefined };
    return null;
  };

  const handleSave = () => {
    const addr = getAddressForSave();
    if (!addr) return;
    setLoading(true);
    if (isEditMode && editId) {
      updateAddress(editId, {
        label,
        customLabel: label === 'Other' ? customLabel : undefined,
        address: addr.address,
        lat: addr.lat,
        lng: addr.lng,
      });
    } else {
      addAddress({
        label,
        customLabel: label === 'Other' ? customLabel : undefined,
        address: addr.address,
        lat: addr.lat,
        lng: addr.lng,
        isDefault: false,
      });
    }
    setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: (addr as any).city });
    setLoading(false);
    router.back();
  };

  const handleUseOnce = () => {
    const addr = getAddressForSave();
    if (!addr) return;
    setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: (addr as any).city });
    router.back();
    setTimeout(() => router.back(), 150);
  };

  const canSave = !!getAddressForSave();
  const modalHeight = Dimensions.get('window').height * 0.85;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <SwipeableBottomSheet
        onDismiss={() => router.back()}
        height={modalHeight}
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'white', borderTopLeftRadius: 40, borderTopRightRadius: 40, overflow: 'hidden', paddingBottom: insets.bottom }}
      >
        <View className="px-5 py-4 flex-row items-center justify-between border-b border-slate-100">
          <TouchableOpacity onPress={() => router.back()} className="p-2 -ml-2">
            <ArrowLeft size={24} color="#334155" />
          </TouchableOpacity>
          <Text className="text-lg font-bold text-slate-800">{isEditMode ? 'Edit location' : isDeliveryMode ? 'Add new location' : 'Add Address'}</Text>
          <View className="w-10" />
        </View>
        <ScrollView
          className="flex-1"
          contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 16, paddingBottom: 16 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text className="text-slate-600 font-bold mb-2">Label</Text>
          <View className="flex-row gap-2 mb-4">
            {LABELS.map((l) => (
              <TouchableOpacity
                key={l.value}
                onPress={() => setLabel(l.value)}
                style={label === l.value ? { backgroundColor: primaryColor, borderColor: primaryColor } : undefined}
                className={`flex-1 py-3 rounded-2xl border items-center ${label === l.value ? '' : 'bg-slate-50 border-slate-200'}`}
              >
                <Text className="text-lg">{l.icon}</Text>
                <Text className={`text-sm font-bold ${label === l.value ? 'text-white' : 'text-slate-600'}`}>{l.value}</Text>
              </TouchableOpacity>
            ))}
          </View>
          {label === 'Other' && (
            <View className="mb-4">
              <Text className="text-slate-600 font-bold mb-2">Custom label (e.g. Gym, Parents)</Text>
              <TextInput
                placeholder="Enter label"
                value={customLabel}
                onChangeText={setCustomLabel}
                className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium"
              />
            </View>
          )}

          <Text className="text-slate-600 font-bold mb-2">Location</Text>
          <TouchableOpacity
            onPress={async () => {
              setAddressLoading(true);
              const result = await fetchCurrentLocation();
              setAddressLoading(false);
              if (result?.lat != null && result?.lng != null) {
                setManualAddressText(result.address);
                setPinCoords({ lat: result.lat, lng: result.lng });
                setSelectedMapboxAddr(null);
                mapRef.current?.animateToRegion({
                  latitude: result.lat,
                  longitude: result.lng,
                  latitudeDelta: 0.02,
                  longitudeDelta: 0.02,
                }, 400);
              }
            }}
            disabled={addressLoading}
            style={{ backgroundColor: `${primaryColor}18`, borderColor: `${primaryColor}4D` }}
            className="flex-row items-center rounded-2xl px-4 py-3 mb-4 border"
          >
            {addressLoading ? <ActivityIndicator size="small" color={primaryColor} /> : <MapPin size={20} color={primaryColor} />}
            <Text className="flex-1 ml-3 font-bold" style={{ color: primaryColor }}>{addressLoading ? 'Getting location...' : 'Use my current location'}</Text>
          </TouchableOpacity>
          <View className="flex-row items-center bg-slate-100 rounded-2xl px-4 py-3 mb-4">
            <Search size={20} color="#94a3b8" />
            <TextInput
              placeholder="Search or type address..."
              value={manualAddressText}
              onChangeText={(t) => { setManualAddressText(t); setSearchQuery(t); setSelectedMapboxAddr(null); }}
              className="flex-1 ml-3 text-slate-700 font-medium"
            />
          </View>
          {searchResults.length > 0 && (
            <View className="mb-4 bg-white rounded-2xl border border-slate-200 overflow-hidden">
              {searchResults.map((r) => (
                <TouchableOpacity
                  key={`${r.lat}-${r.lng}`}
                  onPress={() => {
                    const full = { address: r.address, lat: r.lat, lng: r.lng };
                    setManualAddressText(r.address);
                    setSelectedMapboxAddr(full);
                    setPinCoords({ lat: r.lat, lng: r.lng });
                    setSearchQuery('');
                    mapRef.current?.animateToRegion({
                      latitude: r.lat,
                      longitude: r.lng,
                      latitudeDelta: 0.02,
                      longitudeDelta: 0.02,
                    }, 400);
                  }}
                  className="px-4 py-3 border-b border-slate-100 last:border-b-0"
                >
                  <Text className="text-slate-800 font-medium" numberOfLines={2}>{r.address}</Text>
                </TouchableOpacity>
              ))}
            </View>
          )}

          {shouldRenderNativeMap ? (
            <View className="rounded-2xl overflow-hidden border border-slate-200" style={{ height: MAP_HEIGHT }}>
              <MapView
                ref={mapRef}
                style={{ width: '100%', height: MAP_HEIGHT }}
                initialRegion={mapRegion}
                onPress={async (e) => {
                  const { latitude, longitude } = e.nativeEvent.coordinate;
                  setPinCoords({ lat: latitude, lng: longitude });
                  setSelectedMapboxAddr(null);
                  mapRef.current?.animateToRegion({ latitude, longitude, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
                  const addr = await reverseGeocode(longitude, latitude);
                  if (addr) setManualAddressText(addr);
                }}
                mapType="standard"
                showsUserLocation
              >
                {(() => {
                  const lat = pinCoords?.lat ?? selectedMapboxAddr?.lat ?? address?.lat;
                  const lng = pinCoords?.lng ?? selectedMapboxAddr?.lng ?? address?.lng;
                  if (lat == null || lng == null) return null;
                  return (
                    <Marker
                      coordinate={{ latitude: lat, longitude: lng }}
                      pinColor={primaryColor}
                      draggable
                      onDragEnd={async (e) => {
                        const { latitude, longitude } = e.nativeEvent.coordinate;
                        setPinCoords({ lat: latitude, lng: longitude });
                        setSelectedMapboxAddr(null);
                        const addr = await reverseGeocode(longitude, latitude);
                        if (addr) setManualAddressText(addr);
                      }}
                    />
                  );
                })()}
              </MapView>
            </View>
          ) : (
            <View className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <Text className="text-slate-700 font-medium">Map preview is unavailable on this Android build.</Text>
              <Text className="text-slate-500 text-sm mt-1">
                You can still use "Use my current location" and address search above to save delivery addresses.
              </Text>
            </View>
          )}

          {!isDeliveryMode && (
            <TouchableOpacity
              onPress={handleSave}
              disabled={!canSave || loading}
              style={{ backgroundColor: primaryColor }}
            className="py-4 rounded-2xl items-center mt-4"
            >
              <Text className="text-white font-bold text-lg">{loading ? 'Saving...' : 'Save Address'}</Text>
            </TouchableOpacity>
          )}
        </ScrollView>

        {isDeliveryMode && (
          <View className="gap-3 px-5 pb-4 pt-2 border-t border-slate-100">
            {isEditMode ? (
              <TouchableOpacity
                onPress={handleSave}
                disabled={!canSave || loading}
                style={{ backgroundColor: primaryColor }}
                className="py-4 rounded-2xl items-center"
              >
                <Text className="text-white font-bold text-lg">{loading ? 'Saving...' : 'Save'}</Text>
              </TouchableOpacity>
            ) : (
              <>
                <TouchableOpacity
                  onPress={handleSave}
                  disabled={!canSave || loading}
                  style={{ backgroundColor: primaryColor }}
                className="py-4 rounded-2xl items-center"
                >
                  <Text className="text-white font-bold text-lg">{loading ? 'Saving...' : 'Save address for later'}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleUseOnce}
                  disabled={!canSave}
                  className="bg-slate-100 py-4 rounded-2xl items-center border border-slate-200"
                >
                  <Text className="text-slate-700 font-bold text-lg">Use for this delivery only</Text>
                </TouchableOpacity>
              </>
            )}
          </View>
        )}
      </SwipeableBottomSheet>
    </KeyboardAvoidingView>
  );
}
