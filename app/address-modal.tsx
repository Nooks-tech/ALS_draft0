import { useRouter } from 'expo-router';
import { MapPin, Pencil, Plus, Trash2, X } from 'lucide-react-native';
import { Dimensions, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useSavedAddresses } from '../src/context/SavedAddressesContext';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';

export default function AddressModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { addresses, removeAddress, setDefault } = useSavedAddresses();
  const { setDeliveryAddress } = useCart();

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
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">My Addresses</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          {addresses.length === 0 ? (
            <View className="items-center py-12">
              <View className="w-20 h-20 rounded-full bg-slate-100 justify-center items-center mb-4">
                <MapPin size={40} color="#94a3b8" />
              </View>
              <Text className="text-slate-500 text-center mb-2">No saved addresses yet</Text>
              <Text className="text-slate-400 text-sm text-center">Add Home, Work, or other locations for quick delivery</Text>
            </View>
          ) : (
            addresses.map((addr) => (
              <View
                key={addr.id}
                className="flex-row items-start p-4 mb-3 bg-slate-50 rounded-2xl border border-slate-100"
              >
                <View className="p-2 rounded-xl mr-4" style={{ backgroundColor: `${primaryColor}20` }}>
                  <MapPin size={20} color={primaryColor} />
                </View>
                <View className="flex-1">
                  <View className="flex-row items-center flex-wrap gap-2">
                    <Text className="font-bold text-slate-800">{getDisplayLabel(addr)}</Text>
                    {addr.isDefault && (
                      <View className="px-2 py-0.5 rounded" style={{ backgroundColor: primaryColor }}>
                        <Text className="text-white text-xs font-bold">Default</Text>
                      </View>
                    )}
                  </View>
                  <Text className="text-slate-500 text-sm mt-1">{addr.address}</Text>
                  <View className="flex-row mt-2 gap-3 items-center flex-wrap">
                    {!addr.isDefault && (
                      <TouchableOpacity onPress={() => setDefault(addr.id)}>
                        <Text className="font-bold text-sm" style={{ color: primaryColor }}>Set as default</Text>
                      </TouchableOpacity>
                    )}
                    <TouchableOpacity
                      onPress={() => {
                        setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: addr.city });
                        router.back();
                      }}
                    >
                      <Text className="font-bold text-sm" style={{ color: primaryColor }}>Use for delivery</Text>
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
            className="flex-row items-center justify-center p-4 mt-2 border-2 border-dashed border-slate-200 rounded-2xl"
          >
            <Plus size={20} color={primaryColor} />
            <Text className="font-bold ml-2" style={{ color: primaryColor }}>Add New Address</Text>
          </TouchableOpacity>
        </ScrollView>
      </SwipeableBottomSheet>
    </View>
  );
}
