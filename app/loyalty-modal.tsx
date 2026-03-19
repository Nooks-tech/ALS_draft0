import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { Award, ChevronDown, Gift, Star, TrendingUp, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, Text, TouchableOpacity, View } from 'react-native';
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
  const { primaryColor } = useMerchantBranding();
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

  const tierName = !balance ? 'Bronze' :
    balance.lifetimePoints >= 5000 ? 'Gold' :
    balance.lifetimePoints >= 1000 ? 'Silver' : 'Bronze';
  const tierLabel = tierName === 'Gold' ? (isArabic ? 'ذهبي' : 'Gold') : tierName === 'Silver' ? (isArabic ? 'فضي' : 'Silver') : (isArabic ? 'برونزي' : 'Bronze');

  const tierColor = tierName === 'Gold' ? '#F59E0B' : tierName === 'Silver' ? '#94A3B8' : '#CD7F32';
  const nextTier = tierName === 'Gold' ? null : tierName === 'Silver' ? { name: 'Gold', points: 5000 } : { name: 'Silver', points: 1000 };
  const progress = nextTier ? Math.min(100, ((balance?.lifetimePoints ?? 0) / nextTier.points) * 100) : 100;

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
        <Text className="text-lg font-bold text-slate-800">{isArabic ? 'نقاط الولاء' : 'Loyalty Points'}</Text>
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
          {/* Points Balance Card */}
          {(() => {
            const cardLight = isLightColor(primaryColor);
            const gradientEnd = darkenColor(primaryColor, 0.35);
            const cardTextColor = cardLight ? '#1f2937' : '#ffffff';
            const cardSubTextColor = cardLight ? 'rgba(31,41,55,0.6)' : 'rgba(255,255,255,0.7)';
            return (
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
                  <View
                    style={{
                      position: 'absolute', top: -30, right: -30,
                      width: 120, height: 120, borderRadius: 60,
                      backgroundColor: cardLight ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.08)',
                    }}
                  />
                  <View
                    style={{
                      position: 'absolute', bottom: -20, left: -20,
                      width: 80, height: 80, borderRadius: 40,
                      backgroundColor: cardLight ? 'rgba(0,0,0,0.04)' : 'rgba(255,255,255,0.06)',
                    }}
                  />

                  {/* Header */}
                  <View className="flex-row items-center justify-between mb-5">
                    <View className="flex-row items-center">
                      <View
                        style={{
                          width: 36, height: 36, borderRadius: 18,
                          backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)',
                          alignItems: 'center', justifyContent: 'center',
                        }}
                      >
                        <Star size={18} color={cardTextColor} fill={cardTextColor} />
                      </View>
                      <Text style={{ color: cardTextColor, fontSize: 16, fontWeight: '700', marginLeft: 10 }}>
                        {isArabic ? 'نقاطك' : 'Your Points'}
                      </Text>
                    </View>
                    <View
                      style={{
                        flexDirection: 'row', alignItems: 'center',
                        backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)',
                        paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
                      }}
                    >
                      <Award size={14} color={tierColor} />
                      <Text style={{ color: cardTextColor, fontSize: 12, fontWeight: '600', marginLeft: 4 }}>
                        {tierLabel}
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

                  {/* Tier Progress */}
                  {nextTier && (
                    <View className="mt-5">
                      <View className="flex-row justify-between mb-1.5">
                        <Text style={{ color: cardSubTextColor, fontSize: 11 }}>
                          {balance?.lifetimePoints ?? 0} {isArabic ? 'نقطة' : 'pts'}
                        </Text>
                        <Text style={{ color: cardSubTextColor, fontSize: 11 }}>
                          {isArabic ? `${nextTier.points} نقطة للوصول إلى ${nextTier.name === 'Gold' ? 'الذهبي' : 'الفضي'}` : `${nextTier.points} pts for ${nextTier.name}`}
                        </Text>
                      </View>
                      <View
                        style={{
                          height: 6, borderRadius: 3, overflow: 'hidden',
                          backgroundColor: cardLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.2)',
                        }}
                      >
                        <View
                          style={{
                            height: '100%', borderRadius: 3, width: `${progress}%`,
                            backgroundColor: cardTextColor,
                          }}
                        />
                      </View>
                    </View>
                  )}

                  {/* Divider */}
                  <View
                    style={{
                      height: 1, marginTop: 16, marginBottom: 12,
                      backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)',
                    }}
                  />

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
            );
          })()}

          {/* How it works */}
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

          {/* Stamp Card */}
          {balance?.stampEnabled && (
            <View className="mx-5 mt-6 bg-slate-50 rounded-2xl p-5">
              <Text className="font-bold text-slate-800 mb-3">{isArabic ? 'بطاقة الأختام' : 'Stamp Card'}</Text>
              <View className="flex-row flex-wrap gap-2">
                {Array.from({ length: balance.stampTarget }).map((_, i) => (
                  <View
                    key={i}
                    className="w-9 h-9 rounded-full items-center justify-center"
                    style={{ backgroundColor: i < (balance.stamps ?? 0) ? primaryColor : '#e2e8f0' }}
                  >
                    {i < (balance.stamps ?? 0) ? (
                      <Star size={16} color="white" fill="white" />
                    ) : (
                      <Text className="text-slate-400 text-xs">{i + 1}</Text>
                    )}
                  </View>
                ))}
              </View>
              <Text className="text-slate-500 text-xs mt-3">
                {isArabic ? `تبقى ${balance.stampTarget - (balance.stamps ?? 0)} للحصول على: ${balance.stampRewardDescription}` : `${balance.stampTarget - (balance.stamps ?? 0)} remaining to get: ${balance.stampRewardDescription}`}
              </Text>
            </View>
          )}

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
                <Text className="text-slate-400 text-center py-4">{isArabic ? 'لا توجد معاملات بعد. قم بإجراء طلب لكسب النقاط!' : 'No transactions yet. Make an order to earn points!'}</Text>
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

          {/* Lifetime stats */}
          <View className="mx-5 mt-6 bg-slate-50 rounded-2xl p-5">
            <Text className="font-bold text-slate-800 mb-3">{isArabic ? 'إحصاءات مدى الحياة' : 'Lifetime Stats'}</Text>
            <View className="flex-row justify-between">
              <View>
                <Text className="text-slate-500 text-xs">{isArabic ? 'إجمالي المكتسب' : 'Total Earned'}</Text>
                <Text className="text-slate-800 font-bold text-lg">{balance?.lifetimePoints ?? 0}</Text>
              </View>
              <View>
                <Text className="text-slate-500 text-xs">{isArabic ? 'النقاط المستخدمة' : 'Points Used'}</Text>
                <Text className="text-slate-800 font-bold text-lg">
                  {(balance?.lifetimePoints ?? 0) - (balance?.points ?? 0)}
                </Text>
              </View>
              <View>
                <Text className="text-slate-500 text-xs">{isArabic ? 'المتاح' : 'Available'}</Text>
                <Text className="font-bold text-lg" style={{ color: primaryColor }}>{balance?.points ?? 0}</Text>
              </View>
            </View>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
