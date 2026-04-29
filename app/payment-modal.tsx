import { useFocusEffect, useRouter } from 'expo-router';
import { CreditCard, Plus, ShieldCheck, Trash2, X } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Dimensions, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { paymentApi, type SavedCard } from '../src/api/payment';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';

/**
 * Payment-methods modal. Saved cards live on the server (Moyasar
 * tokens stored in customer_saved_cards by the payment webhook). The
 * customer adds a new card by paying for an order with "Save this
 * card" ticked — there's no manual add-card form here, since holding
 * raw card numbers in the app would put us outside PCI scope.
 */
export default function PaymentModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor } = useMerchantBranding();
  const { merchantId } = useMerchant();
  const isArabic = i18n.language === 'ar';
  const rowDirection: 'row' | 'row-reverse' = isArabic ? 'row-reverse' : 'row';
  const textAlign: 'left' | 'right' = isArabic ? 'right' : 'left';
  const [cards, setCards] = useState<SavedCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const modalHeight = Dimensions.get('window').height * 0.85;

  const loadCards = useCallback(async () => {
    if (!merchantId) {
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const list = await paymentApi.getSavedCards(merchantId);
      setCards(list);
    } catch (e) {
      // Silent — empty list is the right fallback when the user has
      // never tokenised a card and the server returns []. Only an
      // unexpected error path would land here, and surfacing a noisy
      // alert would confuse first-time users.
      setCards([]);
    } finally {
      setLoading(false);
    }
  }, [merchantId]);

  useEffect(() => {
    loadCards();
  }, [loadCards]);

  // Re-load when the user returns from /add-card-modal so the newly
  // saved card shows up without forcing them to close + reopen this
  // modal.
  useFocusEffect(
    useCallback(() => {
      loadCards();
    }, [loadCards]),
  );

  const removeCard = (card: SavedCard) => {
    Alert.alert(
      isArabic ? 'حذف البطاقة' : 'Remove Card',
      isArabic
        ? `هل تريد حذف ${(card.brand || 'بطاقة').toUpperCase()} •••• ${card.last_four || '****'}؟`
        : `Remove ${(card.brand || 'Card').toUpperCase()} •••• ${card.last_four || '****'}?`,
      [
        { text: isArabic ? 'إلغاء' : 'Cancel', style: 'cancel' },
        {
          text: isArabic ? 'حذف' : 'Remove',
          style: 'destructive',
          onPress: async () => {
            setDeletingId(card.id);
            try {
              await paymentApi.deleteSavedCard(card.id);
              setCards((prev) => prev.filter((c) => c.id !== card.id));
            } catch {
              Alert.alert(
                isArabic ? 'فشل الحذف' : 'Delete failed',
                isArabic ? 'تعذر حذف البطاقة. حاول مرة أخرى.' : 'Could not remove the card. Please try again.',
              );
            } finally {
              setDeletingId(null);
            }
          },
        },
      ],
    );
  };

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
          <Text className="text-xl font-bold text-slate-800">{isArabic ? 'طرق الدفع' : 'Payment Methods'}</Text>
          <TouchableOpacity
            onPress={() => router.back()}
            className="p-2"
            style={{ marginRight: isArabic ? 0 : -8, marginLeft: isArabic ? -8 : 0 }}
          >
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          {loading ? (
            <View className="items-center py-12">
              <ActivityIndicator color={primaryColor} />
            </View>
          ) : cards.length === 0 ? (
            <View className="items-center py-8">
              <CreditCard size={48} color="#cbd5e1" />
              <Text className="text-slate-500 font-medium mt-3 text-center" style={{ textAlign: 'center' }}>
                {isArabic ? 'لا توجد بطاقات محفوظة بعد' : 'No saved cards yet'}
              </Text>
              <Text className="text-slate-400 text-sm text-center mt-2 px-4" style={{ textAlign: 'center' }}>
                {isArabic
                  ? 'فعّل "حفظ هذه البطاقة" أثناء إتمام الطلب لحفظها للدفعات القادمة.'
                  : 'Tick "Save this card" during checkout to keep it for faster payments next time.'}
              </Text>
            </View>
          ) : (
            cards.map((card) => (
              <View
                key={card.id}
                className="items-center p-4 mb-3 bg-slate-50 rounded-2xl border border-slate-100"
                style={{ flexDirection: rowDirection }}
              >
                <View
                  className="bg-white p-3 rounded-xl"
                  style={{ marginRight: isArabic ? 0 : 16, marginLeft: isArabic ? 16 : 0 }}
                >
                  <CreditCard size={24} color={primaryColor} />
                </View>
                <View className="flex-1">
                  <Text className="font-bold text-slate-800" style={{ textAlign }}>
                    {(card.brand || 'Card').toUpperCase()} •••• {card.last_four || '****'}
                  </Text>
                  {card.name ? (
                    <Text className="text-slate-500 text-sm" style={{ textAlign }}>{card.name}</Text>
                  ) : null}
                  {card.expires_month && card.expires_year ? (
                    <Text className="text-slate-400 text-xs mt-0.5" style={{ textAlign }}>
                      {isArabic ? 'تنتهي في' : 'Expires'} {String(card.expires_month).padStart(2, '0')}/{String(card.expires_year).slice(-2)}
                    </Text>
                  ) : null}
                </View>
                <TouchableOpacity
                  onPress={() => removeCard(card)}
                  className="p-2"
                  disabled={deletingId === card.id}
                >
                  {deletingId === card.id ? (
                    <ActivityIndicator size="small" color="#ef4444" />
                  ) : (
                    <Trash2 size={18} color="#ef4444" />
                  )}
                </TouchableOpacity>
              </View>
            ))
          )}

          {/* Add-a-card CTA — always visible so the empty state has a
              path forward AND existing-cards users can stack a second
              card without going through checkout. */}
          <TouchableOpacity
            onPress={() => router.push('/add-card-modal')}
            className="items-center justify-center mt-3 py-4 px-4 rounded-2xl border-2 border-dashed border-slate-200"
            style={{ flexDirection: rowDirection }}
            activeOpacity={0.8}
          >
            <Plus size={20} color={primaryColor} />
            <Text
              className="font-bold"
              style={{
                color: primaryColor,
                marginLeft: isArabic ? 0 : 8,
                marginRight: isArabic ? 8 : 0,
              }}
            >
              {isArabic ? 'إضافة بطاقة جديدة' : 'Add New Card'}
            </Text>
          </TouchableOpacity>

          <View
            className="items-center mt-6 px-4 py-3 bg-emerald-50 rounded-2xl"
            style={{ flexDirection: rowDirection }}
          >
            <ShieldCheck size={18} color="#10b981" />
            <Text
              className="text-emerald-700 text-xs flex-1"
              style={{ marginLeft: isArabic ? 0 : 10, marginRight: isArabic ? 10 : 0, textAlign }}
            >
              {isArabic
                ? 'بياناتك محمية بمعيار PCI DSS من Moyasar — لا نقوم بحفظ أرقام البطاقات في تطبيقنا.'
                : 'Card data is held by Moyasar under PCI DSS — we never store raw card numbers on our servers.'}
            </Text>
          </View>
        </ScrollView>
      </SwipeableBottomSheet>
    </View>
  );
}
