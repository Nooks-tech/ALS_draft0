import { useRouter } from 'expo-router';
import { MapPin, Pencil, Plus, Trash2, X } from 'lucide-react-native';
import { Alert, Dimensions, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useSavedAddresses } from '../src/context/SavedAddressesContext';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';

export default function AddressModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const { addresses, removeAddress, setDefault } = useSavedAddresses();
  const { setDeliveryAddress } = useCart();
  const isArabic = i18n.language === 'ar';
  const rowDirection: 'row' | 'row-reverse' = isArabic ? 'row-reverse' : 'row';
  const textAlign: 'left' | 'right' = isArabic ? 'right' : 'left';

  const getDisplayLabel = (addr: (typeof addresses)[0]) =>
    addr.label === 'Other' && addr.customLabel ? addr.customLabel : addr.label;

  const modalHeight = Dimensions.get('window').height * 0.85;

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <SwipeableBottomSheet
        onDismiss={() => router.back()}
        height={modalHeight}
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'white', borderTopLeftRadius: 40, borderTopRightRadius: 40, overflow: 'hidden', maxHeight: '85%' }}
      >
        <View
          className="items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100"
          style={{ flexDirection: rowDirection }}
        >
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'عناويني' : 'My Addresses'}</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="p-2"
            style={{ marginRight: isArabic ? 0 : -8, marginLeft: isArabic ? -8 : 0 }}
          >
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          {addresses.length === 0 ? (
            <View className="items-center py-12">
              <View className="w-20 h-20 rounded-full bg-slate-100 justify-center items-center mb-4">
                <MapPin size={40} color="#94a3b8" />
              </View>
              <Text className="text-slate-500 text-center mb-2">{isArabic ? 'لا توجد عناوين محفوظة بعد' : 'No saved addresses yet'}</Text>
              <Text className="text-slate-400 text-sm text-center">{isArabic ? 'أضف المنزل أو العمل أو أي موقع آخر لتوصيل أسرع' : 'Add Home, Work, or other locations for quick delivery'}</Text>
            </View>
          ) : (
            addresses.map((addr) => (
              <View
                key={addr.id}
                className="items-start p-4 mb-3 bg-slate-50 rounded-2xl border border-slate-100"
                style={{ flexDirection: rowDirection }}
              >
                <View
                  className="p-2 rounded-xl"
                  style={{ backgroundColor: `${primaryColor}20`, marginRight: isArabic ? 0 : 16, marginLeft: isArabic ? 16 : 0 }}
                >
                  <MapPin size={20} color={primaryColor} />
                </View>
                <View className="flex-1">
                  <View className="items-center flex-wrap gap-2" style={{ flexDirection: rowDirection }}>
                    <Text className="font-bold text-slate-800" style={{ textAlign }}>{getDisplayLabel(addr)}</Text>
                    {addr.isDefault && (
                      <View className="px-2 py-0.5 rounded" style={{ backgroundColor: primaryColor }}>
                        <Text className="text-white text-xs font-bold">{isArabic ? 'افتراضي' : 'Default'}</Text>
                      </View>
                    )}
                  </View>
                  <Text className="text-slate-500 text-sm mt-1" style={{ textAlign }}>{addr.address}</Text>
                  <View className="mt-2 gap-3 items-center flex-wrap" style={{ flexDirection: rowDirection }}>
                    {!addr.isDefault && (
                      <TouchableOpacity onPress={() => setDefault(addr.id)}>
                        <Text className="font-bold text-sm" style={{ color: primaryColor }}>{isArabic ? 'تعيين كافتراضي' : 'Set as default'}</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      onPress={() => {
                        // Checkout needs lat/lng for zone + delivery quote.
                        // A saved address with missing coords (legacy row,
                        // or a rare geocoder miss) would cause the quote
                        // request to throw — block the selection up front
                        // and tell the user how to fix it.
                        if (addr.lat == null || addr.lng == null) {
                          Alert.alert(
                            isArabic ? 'العنوان ناقص' : 'Address missing a pin',
                            isArabic
                              ? 'ما قدرنا نحدد الموقع على الخريطة. افتح العنوان وعدّل الموقع قبل الاستخدام.'
                              : "We couldn't pin this address on the map. Edit it and drop a location before using it for delivery.",
                          );
                          return;
                        }
                        setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: addr.city });
                        router.back();
                      }}
                    >
                      <Text className="font-bold text-sm" style={{ color: primaryColor }}>{isArabic ? 'استخدمه للتوصيل' : 'Use for delivery'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => router.push(`/add-address-modal?edit=${addr.id}`)}>
                      <Pencil size={18} color="#64748b" />
                    </TouchableOpacity>
                    <TouchableOpacity onPress={() => removeAddress(addr.id)}>
                      <Trash2 size={18} color="#ef4444" />
                    </TouchableOpacity>
                  </View>
                </View>
              </View>
            ))
          )}
          <TouchableOpacity
            onPress={() => router.push('/add-address-modal')}
            className="items-center justify-center p-4 mt-2 border-2 border-dashed border-slate-200 rounded-2xl"
            style={{ flexDirection: rowDirection }}
          >
            <Plus size={20} color={primaryColor} />
            <Text className="font-bold" style={{ color: primaryColor, marginLeft: isArabic ? 0 : 8, marginRight: isArabic ? 8 : 0 }}>{isArabic ? 'إضافة عنوان جديد' : 'Add New Address'}</Text>
          </TouchableOpacity>
        </ScrollView>
      </SwipeableBottomSheet>
    </View>
  );
}
