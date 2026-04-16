import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { AlertTriangle, ChevronDown, Gift, Star, TrendingUp, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Image, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SafeAreaView } from 'react-native-safe-area-context';
import { loyaltyApi, type LoyaltyBalance, type LoyaltyTransaction } from '../src/api/loyalty';
import { useAuth } from '../src/context/AuthContext';
import { useMerchant } from '../src/context/MerchantContext';
import { PriceWithSymbol } from '../src/components/common/PriceWithSymbol';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})/.exec(hex);
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function darkenColor(hex: string, amount: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const r = Math.max(0, Math.round(rgb.r * (1 - amount)));
  const g = Math.max(0, Math.round(rgb.g * (1 - amount)));
  const b = Math.max(0, Math.round(rgb.b * (1 - amount)));
  return `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
}

function isLightColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  return (rgb.r * 299 + rgb.g * 587 + rgb.b * 114) / 1000 > 160;
}

export default function LoyaltyModal() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const { primaryColor, cafeName } = useMerchantBranding();
  const { user } = useAuth();
  const { merchantId } = useMerchant();
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);
  const isArabic = i18n.language === 'ar';

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    Promise.all([
      loyaltyApi.getBalance(user.id, merchantId).catch(() => null),
      loyaltyApi.getHistory(user.id, merchantId).catch(() => ({ transactions: [] as LoyaltyTransaction[] })),
    ]).then(([bal, hist]) => {
      if (cancelled) return;
      if (bal) setBalance(bal);
      if (hist) setTransactions(hist.transactions);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [user?.id, merchantId]);

  // Tier system removed

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
        <Text className="text-lg font-bold text-slate-800">
          {balance?.loyaltyType === 'stamps'
            ? (isArabic ? 'بطاقة الأختام' : 'Stamp Card')
            : balance?.loyaltyType === 'cashback'
              ? (isArabic ? 'كاش باك' : 'Cashback')
              : (isArabic ? 'نقاط الولاء' : 'Loyalty Points')}
        </Text>
        <TouchableOpacity onPress={() => router.back()} className="p-2">
          <X size={24} color="#64748b" />
        </TouchableOpacity>
      </View>

      {loading ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" color={primaryColor} />
        </View>
      ) : (
        <ScrollView className="flex-1" contentContainerStyle={{ paddingBottom: 40 }}>
          {/* Loyalty Transition Banner */}
          {balance?.transitioning && balance?.oldSystemType && (
            <View className="mx-5 mt-5 rounded-2xl p-4" style={{ backgroundColor: '#FEF3C7' }}>
              <View className="flex-row items-start">
                <AlertTriangle size={20} color="#D97706" style={{ marginTop: 2 }} />
                <View className="flex-1 ml-3">
                  <Text className="font-bold text-amber-800 text-sm">
                    {isArabic ? 'انتقال برنامج الولاء' : 'Loyalty Program Transition'}
                  </Text>
                  <Text className="text-amber-700 text-xs mt-1">
                    {isArabic
                      ? `لديك ${balance.oldSystemBalance} ${balance.oldSystemType === 'cashback' ? 'ر.س كاش باك' : 'طوابع'} متبقية. أنفقها قبل انتهاء صلاحيتها للانتقال إلى برنامج ${balance.loyaltyType === 'stamps' ? 'الطوابع' : 'الكاش باك'} الجديد!`
                      : `You have ${balance.oldSystemType === 'cashback' ? `${balance.oldSystemBalance} SAR cashback` : `${balance.oldSystemBalance} stamps`} remaining. Spend them before they expire to unlock our new ${balance.loyaltyType === 'stamps' ? 'stamps' : 'cashback'} program!`
                    }
                  </Text>
                </View>
              </View>
            </View>
          )}

          {/* ── Main Loyalty Card — render ONLY the card matching loyaltyType ── */}
          {(() => {
            const cardLabel = balance?.walletCardLabel || cafeName || (isArabic ? 'بطاقة الولاء' : 'Loyalty Card');
            const cardBgColor = balance?.walletCardBgColor || primaryColor;
            const cardLight = isLightColor(cardBgColor);
            const gradientEnd = darkenColor(cardBgColor, 0.35);
            const cardTextColor = balance?.walletCardTextColor || (cardLight ? '#1f2937' : '#ffffff');
            const cardSubTextColor = cardLight ? 'rgba(31,41,55,0.6)' : 'rgba(255,255,255,0.7)';
            const stampBoxColor = balance?.walletStampBoxColor || 'rgba(255,255,255,0.15)';
            const stampIconColor = balance?.walletStampIconColor || '#FFFFFF';
            const stampIconUrl = balance?.walletStampIconUrl || null;
            const cardLogoUrl = balance?.walletCardLogoUrl || null;

            const loyaltyType = balance?.loyaltyType ?? 'stamps';

            /* ── STAMPS ── */
            if (loyaltyType === 'stamps') {
              return (
                <>
                  <View
                    className="mx-5 mt-5"
                    style={{
                      borderRadius: 24, overflow: 'hidden',
                      shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                      shadowOpacity: 0.2, shadowRadius: 16, elevation: 10,
                    }}
                  >
                    <LinearGradient
                      colors={[cardBgColor, gradientEnd]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={{ padding: 24, position: 'relative' }}
                    >
                      {/* Top row: logo on the left, Card Title on the right (matches dashboard + Apple Pass) */}
                      <View className="flex-row items-center justify-between mb-5" style={{ gap: 12 }}>
                        {cardLogoUrl ? (
                          <Image
                            source={{ uri: cardLogoUrl }}
                            style={{ width: 40, height: 40, borderRadius: 12 }}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={{ width: 40, height: 40 }} />
                        )}
                        <Text
                          numberOfLines={1}
                          style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'right' }}
                        >
                          {cardLabel}
                        </Text>
                      </View>

                      {/* Stamp grid — filled vs empty boxes reflect the customer's live stamp count */}
                      <View className="flex-row flex-wrap gap-2">
                        {Array.from({ length: balance?.stampTarget ?? 10 }).map((_, i) => (
                          <View
                            key={i}
                            className="w-10 h-10 rounded-xl items-center justify-center"
                            style={{
                              backgroundColor: i < (balance?.stamps ?? 0)
                                ? stampBoxColor
                                : (cardLight ? 'rgba(0,0,0,0.06)' : 'rgba(255,255,255,0.1)'),
                            }}
                          >
                            {i < (balance?.stamps ?? 0) ? (
                              stampIconUrl ? (
                                <Image source={{ uri: stampIconUrl }} style={{ width: 20, height: 20 }} resizeMode="contain" />
                              ) : (
                                <Star size={16} color={stampIconColor} fill={stampIconColor} />
                              )
                            ) : (
                              <Text style={{ color: cardSubTextColor, fontSize: 11 }}>{i + 1}</Text>
                            )}
                          </View>
                        ))}
                      </View>

                      {/* Milestone rewards — 2x2 grid matching Apple Pass
                          secondaryFields (top row) + auxiliaryFields (bottom
                          row). Capped at 4 because that's what a storeCard
                          pass can fit on the front; the dashboard UI enforces
                          the same cap so the card always looks identical. */}
                      {(() => {
                        const filledMilestones = (balance?.stampMilestones ?? [])
                          .filter((m) => (m.reward_name || '').trim().length > 0)
                          .slice()
                          .sort((a, b) => a.stamp_number - b.stamp_number)
                          .slice(0, 4);
                        if (filledMilestones.length === 0) return null;
                        return (
                          <View style={{ marginTop: 16 }}>
                            <View style={{ height: 1, marginBottom: 12, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />
                            <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
                              {filledMilestones.map((m, i) => {
                                const isRightCol = i % 2 === 1;
                                return (
                                  <View
                                    key={m.id ?? m.stamp_number}
                                    style={{
                                      width: '50%',
                                      paddingLeft: isRightCol ? 6 : 0,
                                      paddingRight: isRightCol ? 0 : 6,
                                      marginTop: i >= 2 ? 10 : 0,
                                      alignItems: isRightCol ? 'flex-end' : 'flex-start',
                                    }}
                                  >
                                    <Text style={{ color: cardSubTextColor, fontSize: 10, letterSpacing: 1 }}>
                                      {isArabic ? `الختم ${m.stamp_number}` : `STAMP ${m.stamp_number}`}
                                    </Text>
                                    <Text
                                      numberOfLines={1}
                                      style={{ color: cardTextColor, fontSize: 13, fontWeight: '600', marginTop: 2 }}
                                    >
                                      {(m.reward_name || '').trim()}
                                    </Text>
                                  </View>
                                );
                              })}
                            </View>
                          </View>
                        );
                      })()}
                    </LinearGradient>
                  </View>

                  {/* How it works — stamps */}
                  <View className="mx-5 mt-6">
                    <Text className="text-lg font-bold text-slate-800 mb-4">{isArabic ? 'كيف يعمل' : 'How it works'}</Text>
                    <View className="flex-row gap-4">
                      <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                        <TrendingUp size={24} color={primaryColor} />
                        <Text className="text-slate-800 font-bold mt-2 text-center">{isArabic ? 'اطلب' : 'Order'}</Text>
                        <Text className="text-slate-500 text-xs text-center mt-1">{isArabic ? 'اكسب ختم مع كل طلب' : 'Earn a stamp with every order'}</Text>
                      </View>
                      <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                        <Gift size={24} color={primaryColor} />
                        <Text className="text-slate-800 font-bold mt-2 text-center">{isArabic ? 'استبدل' : 'Redeem'}</Text>
                        <Text className="text-slate-500 text-xs text-center mt-1">
                          {isArabic
                            ? `اجمع ${balance?.stampTarget ?? 10} أختام للمكافأة`
                            : `Collect ${balance?.stampTarget ?? 10} stamps for a reward`}
                        </Text>
                      </View>
                    </View>
                  </View>
                </>
              );
            }

            /* ── CASHBACK ── */
            if (loyaltyType === 'cashback') {
              return (
                <>
                  <View
                    className="mx-5 mt-5"
                    style={{
                      borderRadius: 24, overflow: 'hidden',
                      shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                      shadowOpacity: 0.2, shadowRadius: 16, elevation: 10,
                    }}
                  >
                    <LinearGradient
                      colors={[primaryColor, gradientEnd]}
                      start={{ x: 0, y: 0 }}
                      end={{ x: 1, y: 1 }}
                      style={{ padding: 24, position: 'relative' }}
                    >
                      {/* Decorative circles */}
                      <View style={{ position: 'absolute', top: -30, right: -30, width: 120, height: 120, borderRadius: 60, backgroundColor: cardLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)' }} />
                      <View style={{ position: 'absolute', bottom: -20, left: -20, width: 80, height: 80, borderRadius: 40, backgroundColor: cardLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)' }} />

                      {/* Top row: logo on the left, Card Title on the right (matches dashboard + Apple Pass) */}
                      <View className="flex-row items-center justify-between mb-5" style={{ gap: 12 }}>
                        {cardLogoUrl ? (
                          <Image
                            source={{ uri: cardLogoUrl }}
                            style={{ width: 40, height: 40, borderRadius: 12 }}
                            resizeMode="cover"
                          />
                        ) : (
                          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                            <Gift size={18} color={cardTextColor} />
                          </View>
                        )}
                        <Text
                          numberOfLines={1}
                          style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', flex: 1, textAlign: 'right' }}
                        >
                          {cardLabel}
                        </Text>
                      </View>

                      {/* Cashback balance */}
                      <View className="flex-row items-baseline">
                        <PriceWithSymbol amount={balance?.cashbackBalance ?? 0} iconSize={36} iconColor={cardTextColor} textStyle={{ color: cardTextColor, fontSize: 48, fontWeight: '800', lineHeight: 52 }} />
                      </View>
                      <Text style={{ color: cardSubTextColor, fontSize: 14, marginTop: 4 }}>
                        {isArabic ? 'رصيد الكاش باك' : 'Cashback Balance'}
                      </Text>

                      {/* Divider */}
                      <View style={{ height: 1, marginTop: 16, marginBottom: 12, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />

                      {/* Earn info */}
                      <View className="flex-row items-center">
                        <TrendingUp size={14} color={cardSubTextColor} />
                        <Text style={{ color: cardSubTextColor, fontSize: 13, marginLeft: 6 }}>
                          {isArabic
                            ? `اكسب ${balance?.cashbackPercent ?? 5}% كاش باك على كل طلب`
                            : `Earn ${balance?.cashbackPercent ?? 5}% cashback on every order`}
                        </Text>
                      </View>
                    </LinearGradient>
                  </View>

                  {/* How it works — cashback */}
                  <View className="mx-5 mt-6">
                    <Text className="text-lg font-bold text-slate-800 mb-4">{isArabic ? 'كيف يعمل' : 'How it works'}</Text>
                    <View className="flex-row gap-4">
                      <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                        <TrendingUp size={24} color={primaryColor} />
                        <Text className="text-slate-800 font-bold mt-2 text-center">{isArabic ? 'اكسب' : 'Earn'}</Text>
                        <Text className="text-slate-500 text-xs text-center mt-1">
                          {isArabic
                            ? `${balance?.cashbackPercent ?? 5}% كاش باك على كل طلب`
                            : `${balance?.cashbackPercent ?? 5}% cashback on every order`}
                        </Text>
                      </View>
                      <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                        <Gift size={24} color={primaryColor} />
                        <Text className="text-slate-800 font-bold mt-2 text-center">{isArabic ? 'استبدل' : 'Redeem'}</Text>
                        <Text className="text-slate-500 text-xs text-center mt-1">
                          {isArabic ? 'استخدم رصيدك عند الدفع' : 'Use your balance at checkout'}
                        </Text>
                      </View>
                    </View>
                  </View>
                </>
              );
            }

            /* ── POINTS (default) ── */
            return (
              <>
                <View
                  className="mx-5 mt-5"
                  style={{
                    borderRadius: 24, overflow: 'hidden',
                    shadowColor: '#000', shadowOffset: { width: 0, height: 8 },
                    shadowOpacity: 0.2, shadowRadius: 16, elevation: 10,
                  }}
                >
                  <LinearGradient
                    colors={[primaryColor, gradientEnd]}
                    start={{ x: 0, y: 0 }}
                    end={{ x: 1, y: 1 }}
                    style={{ padding: 24, position: 'relative' }}
                  >
                    {/* Decorative circles */}
                    <View style={{ position: 'absolute', top: -30, right: -30, width: 120, height: 120, borderRadius: 60, backgroundColor: cardLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)' }} />
                    <View style={{ position: 'absolute', bottom: -20, left: -20, width: 80, height: 80, borderRadius: 40, backgroundColor: cardLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)' }} />

                    {/* Header */}
                    <View className="flex-row items-center justify-between mb-5">
                      <View className="flex-row items-center">
                        <View style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)', alignItems: 'center', justifyContent: 'center' }}>
                          <Star size={18} color={cardTextColor} fill={cardTextColor} />
                        </View>
                        <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', marginLeft: 10 }}>
                          {cardLabel}
                        </Text>
                      </View>
                    </View>

                    {/* Points */}
                    <Text style={{ color: cardTextColor, fontSize: 48, fontWeight: '800', lineHeight: 52 }}>
                      {balance?.points ?? 0}
                    </Text>
                    <View className="flex-row items-center mt-1">
                      <Text style={{ color: cardSubTextColor, fontSize: 14 }}>{isArabic ? 'القيمة ' : 'Worth '}</Text>
                      <PriceWithSymbol amount={balance?.pointsValue ?? 0} iconSize={14} iconColor={cardSubTextColor} textStyle={{ color: cardSubTextColor, fontSize: 14 }} />
                    </View>

                    {/* Divider */}
                    <View style={{ height: 1, marginTop: 16, marginBottom: 12, backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)' }} />

                    {/* Earn info */}
                    <View className="flex-row items-center">
                      <TrendingUp size={14} color={cardSubTextColor} />
                      <View className="flex-row flex-wrap items-center" style={{ marginLeft: 6 }}>
                        {balance?.earnMode === 'per_order' ? (
                          <Text style={{ color: cardSubTextColor, fontSize: 13 }}>{isArabic ? `اكسب ${balance?.pointsPerOrder ?? 10} نقطة لكل طلب` : `Earn ${balance?.pointsPerOrder ?? 10} points per order`}</Text>
                        ) : (
                          <>
                            <Text style={{ color: cardSubTextColor, fontSize: 13 }}>{isArabic ? `اكسب ${balance?.pointsPerSar ?? 1} نقطة لكل ` : `Earn ${balance?.pointsPerSar ?? 1} point per `}</Text>
                            <PriceWithSymbol symbolOnly iconSize={13} iconColor={cardSubTextColor} textStyle={{ color: cardSubTextColor, fontSize: 13 }} />
                            <Text style={{ color: cardSubTextColor, fontSize: 13 }}>{isArabic ? ' يتم إنفاقه' : ' spent'}</Text>
                          </>
                        )}
                      </View>
                    </View>
                  </LinearGradient>
                </View>

                {/* How it works — points */}
                <View className="mx-5 mt-6">
                  <Text className="text-lg font-bold text-slate-800 mb-4">{isArabic ? 'كيف يعمل' : 'How it works'}</Text>
                  <View className="flex-row gap-4">
                    <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                      <TrendingUp size={24} color={primaryColor} />
                      <Text className="text-slate-800 font-bold mt-2 text-center">{isArabic ? 'اكسب' : 'Earn'}</Text>
                      <View className="flex-row flex-wrap items-center justify-center mt-1">
                        {balance?.earnMode === 'per_order' ? (
                          <Text className="text-slate-500 text-xs text-center">{isArabic ? `${balance?.pointsPerOrder ?? 10} نقطة لكل طلب` : `${balance?.pointsPerOrder ?? 10} points per order`}</Text>
                        ) : (
                          <>
                            <Text className="text-slate-500 text-xs text-center">{isArabic ? `${balance?.pointsPerSar ?? 1} نقطة لكل ` : `${balance?.pointsPerSar ?? 1} point per `}</Text>
                            <PriceWithSymbol symbolOnly iconSize={12} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 12 }} />
                            <Text className="text-slate-500 text-xs text-center">{isArabic ? ' يتم إنفاقه' : ' spent'}</Text>
                          </>
                        )}
                      </View>
                    </View>
                    <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                      <Gift size={24} color={primaryColor} />
                      <Text className="text-slate-800 font-bold mt-2 text-center">{isArabic ? 'استبدل' : 'Redeem'}</Text>
                      <View className="flex-row items-center justify-center mt-1">
                        <Text className="text-slate-500 text-xs text-center">{isArabic ? 'كل نقطة = ' : 'Each point = '}</Text>
                        <PriceWithSymbol amount={balance?.pointValueSar ?? 0.1} iconSize={12} iconColor="#64748b" textStyle={{ color: '#64748b', fontSize: 12 }} />
                      </View>
                    </View>
                  </View>
                </View>
              </>
            );
          })()}

          {/* Transaction History */}
          <View className="mx-5 mt-6">
            <TouchableOpacity
              onPress={() => setShowHistory(!showHistory)}
              className="flex-row items-center justify-between mb-3"
            >
              <Text className="text-lg font-bold text-slate-800">{isArabic ? 'النشاط الأخير' : 'Recent Activity'}</Text>
              <ChevronDown
                size={20}
                color="#64748b"
                style={{ transform: [{ rotate: showHistory ? '180deg' : '0deg' }] }}
              />
            </TouchableOpacity>
            {showHistory && (
              transactions.length > 0 ? (
                transactions.map((tx) => (
                  <View key={tx.id} className="flex-row items-center py-3 border-b border-slate-50">
                    <View
                      className="w-10 h-10 rounded-full items-center justify-center"
                      style={{ backgroundColor: tx.type === 'earn' ? '#dcfce7' : '#fef3c7' }}
                    >
                      {tx.type === 'earn' ? (
                        <TrendingUp size={18} color="#16a34a" />
                      ) : (
                        <Gift size={18} color="#d97706" />
                      )}
                    </View>
                    <View className="flex-1 ml-3">
                      <Text className="text-slate-800 font-medium text-sm">{tx.description}</Text>
                      <Text className="text-slate-400 text-xs">
                        {new Date(tx.created_at).toLocaleDateString()}
                      </Text>
                    </View>
                    <Text
                      className="font-bold"
                      style={{ color: tx.type === 'earn' ? '#16a34a' : '#d97706' }}
                    >
                      {tx.type === 'earn' ? '+' : ''}{tx.points}
                    </Text>
                  </View>
                ))
              ) : (
                <Text className="text-slate-400 text-center py-4">
                  {isArabic ? 'لا توجد معاملات بعد. قم بإجراء طلب لكسب المكافآت!' : 'No transactions yet. Make an order to start earning!'}
                </Text>
              )
            )}
          </View>

          {/* View full rewards */}
          <TouchableOpacity
            onPress={() => { router.back(); router.replace('/(tabs)/offers'); }}
            className="mx-5 mt-6 bg-slate-50 rounded-2xl p-4 items-center"
          >
            <Text className="font-semibold" style={{ color: primaryColor }}>{isArabic ? 'عرض كتالوج المكافآت' : 'View Rewards Catalog'}</Text>
          </TouchableOpacity>

          {/* Stamp stats */}
          {(balance?.loyaltyType) === 'stamps' && (
            <View className="mx-5 mt-6 bg-slate-50 rounded-2xl p-5">
              <Text className="font-bold text-slate-800 mb-3">{isArabic ? 'إحصاءاتك' : 'Your Stats'}</Text>
              <View className="flex-row justify-between">
                <View>
                  <Text className="text-slate-500 text-xs">{isArabic ? 'الأختام الحالية' : 'Current Stamps'}</Text>
                  <Text className="text-slate-800 font-bold text-lg">{balance?.stamps ?? 0}</Text>
                </View>
                <View>
                  <Text className="text-slate-500 text-xs">{isArabic ? 'بطاقات مكتملة' : 'Cards Completed'}</Text>
                  <Text className="text-slate-800 font-bold text-lg">{balance?.completedCards ?? 0}</Text>
                </View>
                <View>
                  <Text className="text-slate-500 text-xs">{isArabic ? 'الهدف' : 'Target'}</Text>
                  <Text className="font-bold text-lg" style={{ color: primaryColor }}>{balance?.stampTarget ?? 10}</Text>
                </View>
              </View>
            </View>
          )}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
