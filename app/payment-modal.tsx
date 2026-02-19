import { useRouter } from 'expo-router';
import { CreditCard, Plus, Trash2, X } from 'lucide-react-native';
import { useState } from 'react';
import { Dimensions, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';

const CARDS_INITIAL = [
  { id: '1', last4: '4242', brand: 'Visa', expiry: '12/26', isDefault: true },
  { id: '2', last4: '5555', brand: 'Mastercard', expiry: '08/27', isDefault: false },
];

export default function PaymentModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const [cards, setCards] = useState(CARDS_INITIAL);
  const modalHeight = Dimensions.get('window').height * 0.85;

  const removeCard = (id: string) => {
    setCards((prev) => {
      const next = prev.filter((c) => c.id !== id);
      if (next.length > 0 && !next.some((c) => c.isDefault)) {
        next[0] = { ...next[0], isDefault: true };
      }
      return next;
    });
  };

  const setDefaultCard = (id: string) => {
    setCards((prev) => prev.map((c) => ({ ...c, isDefault: c.id === id })));
  };

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <SwipeableBottomSheet
        onDismiss={() => router.back()}
        height={modalHeight}
        style={{ position: 'absolute', bottom: 0, left: 0, right: 0, backgroundColor: 'white', borderTopLeftRadius: 40, borderTopRightRadius: 40, overflow: 'hidden', maxHeight: '85%' }}
      >
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Payment Methods</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          {cards.map((card) => (
            <View key={card.id} className="flex-row items-center p-4 mb-3 bg-slate-50 rounded-2xl border border-slate-100">
              <View className="bg-slate-200 p-3 rounded-xl mr-4"><CreditCard size={24} color="#64748b" /></View>
              <View className="flex-1">
                <View className="flex-row items-center flex-wrap gap-2">
                  <Text className="font-bold text-slate-800">{card.brand} •••• {card.last4}</Text>
                  {card.isDefault && <View className="px-2 py-0.5 rounded" style={{ backgroundColor: primaryColor }}><Text className="text-white text-xs font-bold">Default</Text></View>}
                </View>
                <Text className="text-slate-500 text-sm">Expires {card.expiry}</Text>
                {!card.isDefault && (
                  <TouchableOpacity onPress={() => setDefaultCard(card.id)} className="mt-1">
                    <Text className="font-bold text-sm" style={{ color: primaryColor }}>Set as default</Text>
                  </TouchableOpacity>
                )}
              </View>
              <TouchableOpacity onPress={() => removeCard(card.id)} className="p-2 -mr-2">
                <Trash2 size={18} color="#ef4444" />
              </TouchableOpacity>
            </View>
          ))}
          <TouchableOpacity className="flex-row items-center justify-center p-4 mt-2 border-2 border-dashed border-slate-200 rounded-2xl">
            <Plus size={20} color={primaryColor} />
            <Text className="font-bold ml-2" style={{ color: primaryColor }}>Add New Card</Text>
          </TouchableOpacity>
          <Text className="text-slate-400 text-xs text-center mt-6">All payments are secured with SSL encryption</Text>
        </ScrollView>
      </SwipeableBottomSheet>
    </View>
  );
}
