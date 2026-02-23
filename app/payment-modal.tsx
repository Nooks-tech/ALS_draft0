import AsyncStorage from '@react-native-async-storage/async-storage';
import { useRouter } from 'expo-router';
import { CreditCard, Plus, Trash2, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Dimensions, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';

const STORAGE_KEY = '@als_saved_cards';

type SavedCard = {
  id: string;
  last4: string;
  brand: string;
  expiry: string;
  isDefault: boolean;
};

function detectBrand(num: string): string {
  if (num.startsWith('4')) return 'Visa';
  if (num.startsWith('5')) return 'Mastercard';
  if (num.startsWith('62') || num.startsWith('81')) return 'Mada';
  return 'Card';
}

export default function PaymentModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const modalHeight = Dimensions.get('window').height * 0.85;

  useEffect(() => {
    AsyncStorage.getItem(STORAGE_KEY).then((raw) => {
      if (raw) {
        try { setCards(JSON.parse(raw)); } catch {}
      }
    });
  }, []);

  const persist = useCallback((next: SavedCard[]) => {
    setCards(next);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  }, []);

  const removeCard = (id: string) => {
    const next = cards.filter((c) => c.id !== id);
    if (next.length > 0 && !next.some((c) => c.isDefault)) {
      next[0] = { ...next[0], isDefault: true };
    }
    persist(next);
  };

  const setDefaultCard = (id: string) => {
    persist(cards.map((c) => ({ ...c, isDefault: c.id === id })));
  };

  const handleAddCard = () => {
    const digits = cardNumber.replace(/\s/g, '');
    if (digits.length < 12 || !cardExpiry.includes('/')) {
      Alert.alert('Invalid', 'Please enter a valid card number and expiry (MM/YY).');
      return;
    }
    const last4 = digits.slice(-4);
    const brand = detectBrand(digits);
    const newCard: SavedCard = {
      id: `card-${Date.now()}`,
      last4,
      brand,
      expiry: cardExpiry.trim(),
      isDefault: cards.length === 0,
    };
    persist([...cards, newCard]);
    setShowAddForm(false);
    setCardNumber('');
    setCardExpiry('');
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
          {cards.length === 0 && !showAddForm && (
            <View className="items-center py-8">
              <CreditCard size={48} color="#cbd5e1" />
              <Text className="text-slate-400 mt-3">No saved payment methods</Text>
            </View>
          )}
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

          {showAddForm ? (
            <View className="p-4 bg-slate-50 rounded-2xl border border-slate-100 mt-2">
              <Text className="text-slate-500 text-sm font-bold mb-2">Card Number</Text>
              <TextInput
                placeholder="1234 5678 9012 3456"
                className="bg-white px-4 py-3 rounded-xl text-slate-800 font-medium mb-3 border border-slate-200"
                keyboardType="number-pad"
                maxLength={19}
                value={cardNumber}
                onChangeText={setCardNumber}
              />
              <Text className="text-slate-500 text-sm font-bold mb-2">Expiry</Text>
              <TextInput
                placeholder="MM/YY"
                className="bg-white px-4 py-3 rounded-xl text-slate-800 font-medium mb-4 border border-slate-200"
                maxLength={5}
                value={cardExpiry}
                onChangeText={setCardExpiry}
              />
              <View className="flex-row">
                <TouchableOpacity onPress={() => setShowAddForm(false)} className="flex-1 py-3 rounded-xl items-center border border-slate-200 mr-2">
                  <Text className="font-bold text-slate-600">Cancel</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={handleAddCard} className="flex-1 py-3 rounded-xl items-center" style={{ backgroundColor: primaryColor }}>
                  <Text className="text-white font-bold">Save Card</Text>
                </TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity onPress={() => setShowAddForm(true)} className="flex-row items-center justify-center p-4 mt-2 border-2 border-dashed border-slate-200 rounded-2xl">
              <Plus size={20} color={primaryColor} />
              <Text className="font-bold ml-2" style={{ color: primaryColor }}>Add New Card</Text>
            </TouchableOpacity>
          )}
          <Text className="text-slate-400 text-xs text-center mt-6">All payments are secured with SSL encryption</Text>
        </ScrollView>
      </SwipeableBottomSheet>
    </View>
  );
}
