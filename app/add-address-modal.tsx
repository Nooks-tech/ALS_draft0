import * as Location from 'expo-location';
import { reverseGeocode, searchAddresses, type MapboxSearchResult } from '../src/api/mapbox';
import { useDeliveryAddress } from '../src/hooks/useDeliveryAddress';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useSavedAddresses, type SavedAddress } from '../src/context/SavedAddressesContext';
import { ArrowLeft, MapPin, Search } from 'lucide-react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import Constants from 'expo-constants';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View } from 'react-native';
import MapView, { Marker, PROVIDER_GOOGLE } from 'react-native-maps';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

const LABELS: { value: SavedAddress['label']; icon: string }[] = [
  { value: 'Home', icon: '🏠' },
  { value: 'Work', icon: '💼' },
  { value: 'Other', icon: '📍' },
];

const LABEL_TITLES: Record<SavedAddress['label'], string> = {
  Home: 'المنزل',
  Work: 'العمل',
  Other: 'أخرى' };

type Step = 'map' | 'search' | 'labels';

export default function AddAddressModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { from, edit: editId } = useLocalSearchParams<{ from?: string; edit?: string }>();
  const { primaryColor } = useMerchantBranding();
  const insets = useSafeAreaInsets();
  const { addAddress, updateAddress, addresses } = useSavedAddresses();
  const { setDeliveryAddress } = useCart();
  const isDeliveryMode = from === 'delivery';
  const isEditMode = !!editId;
  const editingAddr = addresses.find((a) => a.id === editId);
  const { fetchCurrentLocation } = useDeliveryAddress();
  const isArabic = i18n.language === 'ar';

  const [step, setStep] = useState<Step>('map');
  const [label, setLabel] = useState<SavedAddress['label'] | null>(null);
  const [customLabel, setCustomLabel] = useState('');
  const [manualAddressText, setManualAddressText] = useState('');
  const [pinCoords, setPinCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [addressLoading, setAddressLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<MapboxSearchResult[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [reverseGeocodeLoading, setReverseGeocodeLoading] = useState(false);

  const runtimeGoogleMapsKey = (
    (Constants.expoConfig?.extra as { googleMapsApiKey?: string } | undefined)?.googleMapsApiKey
    || (typeof process !== 'undefined' && process.env?.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY)
    || ''
  ).trim();
  /** Android needs a Google Maps API key for tiles. iOS can use Apple Maps (default provider) without one. */
  const hasGoogleMapsKey = runtimeGoogleMapsKey.length > 0;
  const shouldRenderNativeMap = Platform.OS === 'ios' || hasGoogleMapsKey;
  /** Google provider on iOS requires Google Maps iOS SDK + key; blank white map is the usual symptom if misconfigured. */
  const mapProvider = Platform.OS === 'android' ? PROVIDER_GOOGLE : undefined;

  const mapRegion = useState({
    latitude: 24.7136,
    longitude: 46.6753,
    latitudeDelta: 0.02,
    longitudeDelta: 0.02 })[0];
  const mapRef = useRef<MapView>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  const searchInputRef = useRef<TextInput>(null);

  const formatReverseGeocodeParts = useCallback((rev?: Location.LocationGeocodedAddress | null) => {
    if (!rev) return null;
    const parts = [rev.name, rev.street, rev.district, rev.subregion, rev.city, rev.region, rev.country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }, []);

  const performSearch = useCallback(async (rawQuery: string) => {
    const query = rawQuery.trim();
    if (query.length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }

    setSearchLoading(true);
    try {
      let results = await searchAddresses(query, 8);

      // Fallback to native geocoding so search still works even if Google Geocoding
      // is unavailable or not enabled for the API key.
      if (!results.length) {
        const nativeResults = await Location.geocodeAsync(query);
        const hydrated = await Promise.all(
          nativeResults.slice(0, 6).map(async (item) => {
            try {
              const [rev] = await Location.reverseGeocodeAsync({
                latitude: item.latitude,
                longitude: item.longitude });
              return {
                address: formatReverseGeocodeParts(rev) || query,
                lat: item.latitude,
                lng: item.longitude };
            } catch {
              return {
                address: query,
                lat: item.latitude,
                lng: item.longitude };
            }
          }),
        );

        const seen = new Set<string>();
        results = hydrated.filter((item) => {
          const key = `${item.address}-${item.lat.toFixed(5)}-${item.lng.toFixed(5)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      }

      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearchLoading(false);
    }
  }, [formatReverseGeocodeParts]);

  // Search debounce (min 2 chars for Arabic/short queries)
  useEffect(() => {
    if (!searchQuery || searchQuery.trim().length < 2) {
      setSearchResults([]);
      setSearchLoading(false);
      return;
    }
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      void performSearch(searchQuery);
    }, 350);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [performSearch, searchQuery]);

  useEffect(() => {
    if (step === 'search') {
      const timer = setTimeout(() => searchInputRef.current?.focus(), 150);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [step]);

  useEffect(() => {
    if (step !== 'map' || !pinCoords) return;
    const timer = setTimeout(() => {
      mapRef.current?.animateToRegion({
        latitude: pinCoords.lat,
        longitude: pinCoords.lng,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02 }, 400);
    }, 120);
    return () => clearTimeout(timer);
  }, [pinCoords, step]);

  // Init: edit mode or current location
  useEffect(() => {
    if (editId && !editingAddr) return;
    if (editingAddr) {
      setManualAddressText(editingAddr.address);
      if (editingAddr.lat != null && editingAddr.lng != null) {
        setPinCoords({ lat: editingAddr.lat, lng: editingAddr.lng });
        mapRef.current?.animateToRegion({
          latitude: editingAddr.lat,
          longitude: editingAddr.lng,
          latitudeDelta: 0.02,
          longitudeDelta: 0.02 }, 400);
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
          longitudeDelta: 0.02 }, 400);
      }
    });
  }, [fetchCurrentLocation, editingAddr?.id, editId]);

  const updateAddressFromCoords = useCallback(async (lat: number, lng: number) => {
    setPinCoords({ lat, lng });
    setReverseGeocodeLoading(true);
    try {
      // Use expo-location reverse geocode (device native) - works without Google Geocoding API
      const [rev] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      if (rev) {
        const addr = formatReverseGeocodeParts(rev);
        setManualAddressText(addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
      } else {
        // Fallback to Google Geocoding API if expo returns nothing
        const addr = await reverseGeocode(lng, lat);
        setManualAddressText(addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
      }
    } catch {
      const addr = await reverseGeocode(lng, lat);
      setManualAddressText(addr || `${lat.toFixed(6)}, ${lng.toFixed(6)}`);
    } finally {
      setReverseGeocodeLoading(false);
    }
  }, [formatReverseGeocodeParts]);

  const handleMapPress = useCallback(async (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    mapRef.current?.animateToRegion({ latitude, longitude, latitudeDelta: 0.02, longitudeDelta: 0.02 }, 400);
    await updateAddressFromCoords(latitude, longitude);
  }, [updateAddressFromCoords]);

  const handleMarkerDragEnd = useCallback(async (e: { nativeEvent: { coordinate: { latitude: number; longitude: number } } }) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    await updateAddressFromCoords(latitude, longitude);
  }, [updateAddressFromCoords]);

  const focusCurrentLocation = useCallback(async () => {
    setAddressLoading(true);
    const result = await fetchCurrentLocation();
    setAddressLoading(false);
    if (result?.lat != null && result?.lng != null) {
      setManualAddressText(result.address);
      setPinCoords({ lat: result.lat, lng: result.lng });
      mapRef.current?.animateToRegion({
        latitude: result.lat,
        longitude: result.lng,
        latitudeDelta: 0.02,
        longitudeDelta: 0.02 }, 400);
    }
  }, [fetchCurrentLocation]);

  const selectSearchResult = useCallback((r: MapboxSearchResult) => {
    setSearchQuery('');
    setSearchResults([]);
    setSearchFocused(false);
    Keyboard.dismiss();
    setManualAddressText(r.address);
    setPinCoords({ lat: r.lat, lng: r.lng });
    setStep('map');
  }, []);

  const dismissSearchResults = useCallback(() => {
    setTimeout(() => setSearchFocused(false), 400);
  }, []);

  const openSearchScreen = useCallback(() => {
    setStep('search');
    setSearchFocused(true);
  }, []);

  const closeSearchScreen = useCallback(() => {
    Keyboard.dismiss();
    setSearchFocused(false);
    setStep('map');
  }, []);

  const getAddressForSave = useCallback(() => {
    if (pinCoords) {
      return {
        address: manualAddressText.trim() || `${pinCoords.lat.toFixed(6)}, ${pinCoords.lng.toFixed(6)}`,
        lat: pinCoords.lat,
        lng: pinCoords.lng };
    }
    if (manualAddressText.trim()) return { address: manualAddressText.trim(), lat: undefined, lng: undefined };
    return null;
  }, [pinCoords, manualAddressText]);

  const handleConfirmLocation = useCallback(() => {
    const addr = getAddressForSave();
    if (!addr || (!pinCoords && !manualAddressText.trim())) return;
    if (isEditMode && editingAddr) {
      setLabel(editingAddr.label);
      setCustomLabel(editingAddr.customLabel || '');
    }
    setStep('labels');
  }, [getAddressForSave, pinCoords, manualAddressText, isEditMode, editingAddr]);

  const handleSave = useCallback(() => {
    const addr = getAddressForSave();
    if (!addr) return;
    if (!label) return;
    setLoading(true);
    if (isEditMode && editId) {
      updateAddress(editId, {
        label: label,
        customLabel: label === 'Other' ? customLabel : undefined,
        address: addr.address,
        lat: addr.lat,
        lng: addr.lng });
    } else {
      addAddress({
        label,
        customLabel: label === 'Other' ? customLabel : undefined,
        address: addr.address,
        lat: addr.lat,
        lng: addr.lng,
        isDefault: false });
    }
    setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: (addr as any).city });
    setLoading(false);
    router.back();
  }, [getAddressForSave, label, customLabel, isEditMode, editId, updateAddress, addAddress, setDeliveryAddress, router]);

  const handleUseOnce = useCallback(() => {
    const addr = getAddressForSave();
    if (!addr) return;
    if (!label) return;
    setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: (addr as any).city });
    router.back();
    setTimeout(() => router.back(), 150);
  }, [getAddressForSave, label, setDeliveryAddress, router]);

  const canConfirmLocation = !!pinCoords || !!manualAddressText.trim();
  const canSave = !!getAddressForSave() && !!label;

  if (step === 'search') {
    return (
      <SafeAreaView className="flex-1 bg-white">
        <View className="px-4 pt-2 pb-3 border-b border-slate-100">
          <View className="flex-row items-center">
            <TouchableOpacity onPress={closeSearchScreen} className="p-2 rounded-full">
              <ArrowLeft size={22} color="#334155" />
            </TouchableOpacity>
            <View className="flex-1 ml-2 rounded-2xl border bg-white flex-row items-center px-4 py-3" style={{ borderColor: primaryColor }}>
              <Search size={20} color="#0f172a" />
              <TextInput
                ref={searchInputRef}
                placeholder={isArabic ? 'ابحث عن عنوان' : 'Search for address'}
                placeholderTextColor="#94a3b8"
                value={searchQuery}
                onChangeText={setSearchQuery}
                onFocus={() => setSearchFocused(true)}
                className="flex-1 ml-3 text-slate-800 font-medium text-lg"
                returnKeyType="search"
                onSubmitEditing={() => void performSearch(searchQuery)}
              />
            </View>
          </View>
        </View>

        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="always"
          contentContainerStyle={{ paddingBottom: 24 }}
          showsVerticalScrollIndicator={false}
        >
          {searchQuery.trim().length < 2 ? (
            <View className="px-6 py-8">
              <Text className="text-slate-400 text-base">
                {isArabic ? 'اكتب حرفين أو أكثر للبحث عن موقع' : 'Type at least 2 characters to search for a location'}
              </Text>
            </View>
          ) : searchLoading ? (
            <View className="px-6 py-10 items-center">
              <ActivityIndicator size="small" color={primaryColor} />
              <Text className="text-slate-500 text-sm mt-3">{isArabic ? 'جاري البحث...' : 'Searching...'}</Text>
            </View>
          ) : searchResults.length === 0 ? (
            <View className="px-6 py-8">
              <Text className="text-slate-500 text-base">{isArabic ? 'لا توجد نتائج' : 'No results found'}</Text>
            </View>
          ) : (
            searchResults.map((r) => (
              <TouchableOpacity
                key={`${r.lat}-${r.lng}-${r.address}`}
                onPress={() => selectSearchResult(r)}
                className="px-6 py-4 border-b border-slate-100"
                activeOpacity={0.7}
              >
                <Text className="text-slate-900 font-bold text-xl mb-1" numberOfLines={1}>
                  {r.address.split(',')[0]?.trim() || r.address}
                </Text>
                <Text className="text-slate-500 text-base" numberOfLines={2}>
                  {r.address}
                </Text>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // Step 2: Labels
  if (step === 'labels') {
    return (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
      >
        <SafeAreaView className="flex-1 bg-white">
          <View className="px-5 py-4 flex-row items-center justify-between border-b border-slate-100">
            <TouchableOpacity onPress={() => setStep('map')} className="bg-slate-100 p-2 rounded-full">
              <ArrowLeft size={22} color="#334155" />
            </TouchableOpacity>
            <Text className="text-lg font-bold text-slate-800">{isArabic ? 'اختر التسمية' : 'Choose label'}</Text>
            <View className="w-10" />
          </View>
          <ScrollView
            className="flex-1"
            contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 24, paddingBottom: 120 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View className="bg-slate-50 rounded-2xl px-4 py-3 border border-slate-100 mb-6">
              <Text className="text-slate-500 text-xs font-bold mb-1">{isArabic ? 'العنوان المحدد' : 'Selected address'}</Text>
              <Text className="text-slate-700 text-sm font-medium" numberOfLines={2}>{manualAddressText}</Text>
            </View>

            <Text className="text-slate-600 font-bold text-sm mb-3">{isArabic ? 'التسمية' : 'Label'}</Text>
            <View className="flex-row gap-2 mb-4">
              {LABELS.map((l) => (
                <TouchableOpacity
                  key={l.value}
                  onPress={() => setLabel(l.value)}
                  style={label === l.value ? { backgroundColor: primaryColor, borderColor: primaryColor } : undefined}
                  className={`flex-1 py-3 rounded-2xl border items-center ${label === l.value ? '' : 'bg-slate-50 border-slate-200'}`}
                >
                  <Text className="text-lg">{l.icon}</Text>
                  <Text className={`text-sm font-bold mt-1 ${label === l.value ? 'text-white' : 'text-slate-600'}`}>{isArabic ? LABEL_TITLES[l.value] : l.value}</Text>
                </TouchableOpacity>
              ))}
            </View>
            {label === 'Other' && (
              <View className="mb-4">
                <Text className="text-slate-600 font-bold text-sm mb-2">{isArabic ? 'تسمية مخصصة (مثل النادي، الوالدين)' : 'Custom label (e.g. Gym, Parents)'}</Text>
                <TextInput
                  placeholder={isArabic ? 'أدخل التسمية' : 'Enter label'}
                  value={customLabel}
                  onChangeText={setCustomLabel}
                  className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium text-sm"
                />
              </View>
            )}
          </ScrollView>

          <View className="p-6 pt-4 pb-8 bg-white border-t border-slate-100">
            {isEditMode ? (
              <TouchableOpacity
                onPress={handleSave}
                disabled={!canSave || loading}
                style={{ backgroundColor: primaryColor }}
                className="py-4 rounded-[28px] items-center"
              >
                <Text className="text-white font-bold text-base">{loading ? (isArabic ? 'جارٍ الحفظ...' : 'Saving...') : (isArabic ? 'حفظ' : 'Save')}</Text>
              </TouchableOpacity>
            ) : isDeliveryMode ? (
              <View className="gap-3">
                <TouchableOpacity
                  onPress={handleSave}
                  disabled={!canSave || loading}
                  style={{ backgroundColor: primaryColor }}
                  className="py-4 rounded-[28px] items-center"
                >
                  <Text className="text-white font-bold text-base">{loading ? (isArabic ? 'جارٍ الحفظ...' : 'Saving...') : (isArabic ? 'حفظ العنوان لوقت لاحق' : 'Save address for later')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  onPress={handleUseOnce}
                  disabled={!canSave}
                  className="bg-slate-100 py-4 rounded-[28px] items-center border border-slate-200"
                >
                  <Text className="text-slate-700 font-bold text-base">{isArabic ? 'استخدمه لهذا التوصيل فقط' : 'Use for this delivery only'}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <TouchableOpacity
                onPress={handleSave}
                disabled={!canSave || loading}
                style={{ backgroundColor: primaryColor }}
                className="py-4 rounded-[28px] items-center"
              >
                <Text className="text-white font-bold text-base">{loading ? (isArabic ? 'جارٍ الحفظ...' : 'Saving...') : (isArabic ? 'حفظ العنوان' : 'Save Address')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </SafeAreaView>
      </KeyboardAvoidingView>
    );
  }

  // Step 1: Full-screen map
  if (!shouldRenderNativeMap) {
    return (
      <SafeAreaView className="flex-1 bg-white">
        <View className="px-5 py-4 flex-row items-center justify-between border-b border-slate-100">
          <TouchableOpacity onPress={() => router.back()} className="bg-slate-100 p-2 rounded-full">
            <ArrowLeft size={22} color="#334155" />
          </TouchableOpacity>
          <Text className="text-lg font-bold text-slate-800">{isArabic ? 'اختر موقع التوصيل' : 'Select Delivery Location'}</Text>
          <View className="w-10" />
        </View>
        <View className="flex-1 items-center justify-center p-8">
          <Text className="text-slate-700 font-medium text-center">{isArabic ? 'معاينة الخريطة غير متاحة.' : 'Map preview is unavailable.'}</Text>
          <Text className="text-slate-500 text-sm mt-2 text-center">{isArabic ? 'يمكنك حفظ عنوانك بعد تحديد الموقع على الخريطة.' : 'You can save your address after choosing the location on the map.'}</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#e2e8f0' }}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        provider={mapProvider}
        initialRegion={mapRegion}
        onPress={handleMapPress}
        mapType="standard"
        showsUserLocation
        showsMyLocationButton={false}
        loadingEnabled
        mapPadding={{ bottom: 220, top: 120, left: 0, right: 0 }}
      >
        {pinCoords && (
          <Marker
            coordinate={{ latitude: pinCoords.lat, longitude: pinCoords.lng }}
            pinColor={primaryColor}
            draggable
            onDragEnd={handleMarkerDragEnd}
          />
        )}
      </MapView>

      {/* Header overlay - box-none so map receives touches outside header/search */}
      <SafeAreaView edges={['top']} className="absolute top-0 left-0 right-0" pointerEvents="box-none">
        <View className="px-5 pt-6 pb-4 flex-row items-center justify-between">
          <TouchableOpacity onPress={() => router.back()} className="bg-white p-2 rounded-full shadow-sm">
            <ArrowLeft size={22} color="#334155" />
          </TouchableOpacity>
          <Text className="text-lg font-bold text-slate-800">{isArabic ? 'اختر موقع التوصيل' : 'Select Delivery Location'}</Text>
          <View className="w-10" />
        </View>

        {/* Search bar */}
        <View className="px-5 mt-2" pointerEvents="box-none">
          <TouchableOpacity
            onPress={openSearchScreen}
            activeOpacity={0.9}
            className="bg-white rounded-2xl flex-row items-center px-4 py-3 shadow-lg border border-slate-100"
          >
            <Search size={20} color="#94a3b8" />
            <Text className={`ml-3 flex-1 text-base ${manualAddressText ? 'text-slate-700' : 'text-slate-400'}`} numberOfLines={1}>
              {searchQuery || (isArabic ? 'ابحث عن عنوان' : 'Search for address')}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>

      {/* Re-center button */}
      <View className="absolute bottom-[220] left-5">
        <TouchableOpacity
          onPress={focusCurrentLocation}
          disabled={addressLoading}
          className="bg-white w-12 h-12 rounded-2xl items-center justify-center shadow-lg border border-slate-100"
        >
          {addressLoading ? (
            <ActivityIndicator size="small" color={primaryColor} />
          ) : (
            <MapPin size={22} color={primaryColor} />
          )}
        </TouchableOpacity>
      </View>

      {/* Bottom card flush to screen bottom */}
      <View className="absolute bottom-0 left-0 right-0 bg-white">
        <View
          className="bg-white rounded-t-[32px] px-6 pt-5 shadow-2xl border-t border-slate-100"
          style={{ paddingBottom: Math.max(insets.bottom, 6) }}
        >
          <Text className="text-slate-400 text-xs font-bold mb-1">{isArabic ? 'موقع التوصيل' : 'Delivery Location'}</Text>
          <Text className="text-slate-900 font-bold text-lg mb-1" numberOfLines={1}>
            {reverseGeocodeLoading ? (isArabic ? 'جاري تحميل العنوان...' : 'Loading address...') : (manualAddressText ? manualAddressText.split(',')[0]?.trim() || manualAddressText : (isArabic ? 'حدد موقعاً على الخريطة' : 'Select a location on the map'))}
          </Text>
          <Text className="text-slate-500 text-sm mb-4" numberOfLines={2}>
            {manualAddressText || (isArabic ? 'انقر على الخريطة لوضع الدبوس' : 'Tap on the map to place the pin')}
          </Text>
          <TouchableOpacity
            onPress={handleConfirmLocation}
            disabled={!canConfirmLocation}
            style={{ backgroundColor: canConfirmLocation ? primaryColor : '#e2e8f0' }}
            className="py-3.5 rounded-[28px] items-center justify-center min-h-[50px]"
          >
            <Text className="font-bold text-base" style={{ color: canConfirmLocation ? '#fff' : '#94a3b8' }}>
              {isArabic ? 'تأكيد الموقع' : 'Confirm Location'}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}
