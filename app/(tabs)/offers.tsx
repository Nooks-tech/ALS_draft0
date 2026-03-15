import * as FileSystem from 'expo-file-system';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';
import { ArrowLeft, Award, ChevronDown, Gift, Star, TrendingUp } from 'lucide-react-native';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Linking,
  Platform,
  ScrollView,
  StatusBar,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_URL } from '../../src/api/config';
import { fetchNooksBanners, type NooksBanner } from '../../src/api/nooksBanners';
import { fetchNooksPromos } from '../../src/api/nooksPromos';
import {
  loyaltyApi,
  type LoyaltyBalance,
  type LoyaltyReward,
  type LoyaltyTransaction,
} from '../../src/api/loyalty';
import { OfferCard } from '../../src/components/common/OfferCard';
import { useMerchant } from '../../src/context/MerchantContext';
import { useMerchantBranding } from '../../src/context/MerchantBrandingContext';
import { useAuth } from '../../src/context/AuthContext';

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

function formatExpiry(validUntil?: string): string {
  if (!validUntil) return 'Valid for limited time';
  try {
    const d = new Date(validUntil);
    return isNaN(d.getTime()) ? 'Valid for limited time' : `Valid until ${d.toLocaleDateString()}`;
  } catch {
    return 'Valid for limited time';
  }
}

export default function OffersScreen() {
  const router = useRouter();
  const { merchantId } = useMerchant();
  const { backgroundColor, menuCardColor, textColor, primaryColor } = useMerchantBranding();
  const { user } = useAuth();
  const [tab, setTab] = useState<'offers' | 'points'>('offers');

  // Offers data
  const [nooksBanners, setNooksBanners] = useState<NooksBanner[]>([]);
  const [nooksPromos, setNooksPromos] = useState<Array<{
    id: string; code: string; name: string; description?: string;
    valid_until?: string; image_url?: string | null; imageUrl?: string | null;
  }>>([]);

  // Loyalty data
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [rewards, setRewards] = useState<LoyaltyReward[]>([]);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [loyaltyLoading, setLoyaltyLoading] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [redeemingId, setRedeemingId] = useState<string | null>(null);
  const [appleWalletAvailable, setAppleWalletAvailable] = useState(false);
  const [googleWalletAvailable, setGoogleWalletAvailable] = useState(false);

  useEffect(() => {
    if (!merchantId) return;
    fetchNooksBanners(merchantId).then(setNooksBanners);
    fetchNooksPromos(merchantId).then(setNooksPromos);
  }, [merchantId]);

  const loadLoyalty = useCallback(async () => {
    if (!user?.id || !merchantId) return;
    setLoyaltyLoading(true);
    try {
      const [bal, hist, rw] = await Promise.all([
        loyaltyApi.getBalance(user.id, merchantId).catch(() => null),
        loyaltyApi.getHistory(user.id, merchantId).catch(() => ({ transactions: [] as LoyaltyTransaction[] })),
        loyaltyApi.getRewards(merchantId).catch(() => ({ rewards: [] as LoyaltyReward[] })),
      ]);
      if (bal) setBalance(bal);
      if (hist) setTransactions(hist.transactions);
      if (rw) setRewards(rw.rewards);
    } catch { /* best-effort */ }
    setLoyaltyLoading(false);

    const checks = await Promise.all([
      fetch(`${API_URL}/api/loyalty/wallet-pass/check`).then(r => r.ok).catch(() => false),
      fetch(`${API_URL}/api/loyalty/google-wallet/check`).then(r => r.ok && r.json().then((d: any) => d.available)).catch(() => false),
    ]);
    setAppleWalletAvailable(Platform.OS === 'ios' && checks[0]);
    setGoogleWalletAvailable(Platform.OS === 'android' && checks[1]);
  }, [user?.id, merchantId]);

  useEffect(() => {
    if (tab === 'points') loadLoyalty();
  }, [tab, loadLoyalty]);

  const handleRedeemReward = async (reward: LoyaltyReward) => {
    if (!user?.id || !merchantId) return;
    if ((balance?.points ?? 0) < reward.points_cost) {
      Alert.alert('Not enough points', `You need ${reward.points_cost} points but only have ${balance?.points ?? 0}.`);
      return;
    }
    Alert.alert('Redeem Reward', `Spend ${reward.points_cost} points for "${reward.name}"?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Redeem',
        onPress: async () => {
          setRedeemingId(reward.id);
          try {
            const result = await loyaltyApi.redeemReward(user.id, reward.id, merchantId);
            Alert.alert('Redeemed!', `You redeemed "${result.reward}". Show this to the staff.`);
            loadLoyalty();
          } catch {
            Alert.alert('Error', 'Failed to redeem reward.');
          }
          setRedeemingId(null);
        },
      },
    ]);
  };

  const offerList = useMemo(() => {
    if (nooksPromos.length > 0) {
      return nooksPromos.map((p) => ({
        id: p.id,
        title: p.name,
        description: p.description ?? `Use code ${p.code} at checkout`,
        code: p.code,
        expiry: formatExpiry(p.valid_until),
        image: typeof p.image_url === 'string' ? p.image_url.trim()
          : (typeof p.imageUrl === 'string' ? p.imageUrl.trim() : undefined),
      }));
    }
    return [];
  }, [nooksPromos]);

  const visibleBannerCards = useMemo(
    () => nooksBanners.filter((b) => b.placement === 'offers' || b.placement === 'slider'),
    [nooksBanners],
  );

  const tierName = !balance ? 'Bronze' :
    balance.lifetimePoints >= 5000 ? 'Gold' :
    balance.lifetimePoints >= 1000 ? 'Silver' : 'Bronze';
  const tierColor = tierName === 'Gold' ? '#F59E0B' : tierName === 'Silver' ? '#94A3B8' : '#CD7F32';

  return (
    <View className="flex-1" style={{ backgroundColor }}>
      <StatusBar barStyle="dark-content" />
      {/* Header */}
      <View
        className="pt-14 pb-3 px-5 flex-row items-center"
        style={{ backgroundColor, borderBottomWidth: 1, borderBottomColor: '#e2e8f0' }}
      >
        <TouchableOpacity onPress={() => router.replace('/(tabs)/menu')} className="mr-4 p-2 -ml-2">
          <ArrowLeft size={24} color={textColor} />
        </TouchableOpacity>
        <Text className="text-xl font-bold flex-1" style={{ color: textColor }}>
          {tab === 'offers' ? 'Offers' : 'Points'}
        </Text>
      </View>

      {/* Toggle */}
      <View className="flex-row mx-5 mt-3 rounded-xl overflow-hidden" style={{ backgroundColor: menuCardColor, borderWidth: 1, borderColor: '#e2e8f0' }}>
        <TouchableOpacity
          onPress={() => setTab('offers')}
          className="flex-1 py-2.5 items-center"
          style={tab === 'offers' ? { backgroundColor: primaryColor } : {}}
        >
          <Text className="text-sm font-semibold" style={{ color: tab === 'offers' ? '#fff' : textColor }}>Offers</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTab('points')}
          className="flex-1 py-2.5 items-center"
          style={tab === 'points' ? { backgroundColor: primaryColor } : {}}
        >
          <Text className="text-sm font-semibold" style={{ color: tab === 'points' ? '#fff' : textColor }}>Points</Text>
        </TouchableOpacity>
      </View>

      {/* Offers Tab */}
      {tab === 'offers' && (
        <FlatList
          data={offerList}
          keyExtractor={(item) => item.id}
          ListHeaderComponent={
            offerList.length === 0 && visibleBannerCards.length > 0 ? (
              <View className="mb-4">
                {visibleBannerCards.map((b) => (
                  <TouchableOpacity key={b.id} activeOpacity={1} className="mb-3 rounded-2xl overflow-hidden shadow-sm" style={{ backgroundColor: menuCardColor }}>
                    <Image source={{ uri: b.image_url }} className="w-full h-40 bg-slate-200" resizeMode="cover" />
                    {(b.title || b.subtitle) && (
                      <View className="p-3">
                        {b.subtitle ? <Text className="text-lg font-bold" style={{ color: textColor }}>{b.subtitle}</Text> : null}
                        {b.title ? <Text style={{ color: textColor }}>{b.title}</Text> : null}
                      </View>
                    )}
                  </TouchableOpacity>
                ))}
              </View>
            ) : null
          }
          ListEmptyComponent={
            visibleBannerCards.length === 0 ? (
              <View className="items-center justify-center py-20">
                <Gift size={48} color="#94a3b8" />
                <Text className="text-slate-400 mt-3 text-center">No offers available right now.</Text>
              </View>
            ) : null
          }
          renderItem={({ item }) => <OfferCard {...item} />}
          contentContainerStyle={{ padding: 16 }}
        />
      )}

      {/* Points Tab */}
      {tab === 'points' && (
        loyaltyLoading && !balance ? (
          <View className="flex-1 items-center justify-center">
            <ActivityIndicator size="large" color={primaryColor} />
          </View>
        ) : (
          <ScrollView className="flex-1" contentContainerStyle={{ padding: 16, paddingBottom: 40 }}>
            {/* Points Balance Card */}
            {(() => {
              const cardLight = isLightColor(primaryColor);
              const gradientEnd = darkenColor(primaryColor, 0.35);
              const cardTextColor = cardLight ? '#1f2937' : '#ffffff';
              const cardSubTextColor = cardLight ? 'rgba(31,41,55,0.6)' : 'rgba(255,255,255,0.7)';
              return (
                <View
                  style={{
                    borderRadius: 24,
                    overflow: 'hidden',
                    shadowColor: '#000',
                    shadowOffset: { width: 0, height: 8 },
                    shadowOpacity: 0.2,
                    shadowRadius: 16,
                    elevation: 10,
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
                          Your Points
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
                          {tierName}
                        </Text>
                      </View>
                    </View>

                    {/* Points */}
                    <Text style={{ color: cardTextColor, fontSize: 48, fontWeight: '800', lineHeight: 52 }}>
                      {balance?.points ?? 0}
                    </Text>
                    <Text style={{ color: cardSubTextColor, fontSize: 14, marginTop: 4 }}>
                      Worth {balance?.pointsValue?.toFixed(2) ?? '0.00'} SAR
                    </Text>

                    {/* Divider */}
                    <View
                      style={{
                        height: 1, marginVertical: 16,
                        backgroundColor: cardLight ? 'rgba(0,0,0,0.08)' : 'rgba(255,255,255,0.15)',
                      }}
                    />

                    {/* Earn rate */}
                    <View className="flex-row items-center">
                      <TrendingUp size={14} color={cardSubTextColor} />
                      <Text style={{ color: cardSubTextColor, fontSize: 13, marginLeft: 6 }}>
                        {balance?.earnMode === 'per_order'
                          ? `Earn ${balance?.pointsPerOrder ?? 10} points per order`
                          : `Earn ${balance?.pointsPerSar ?? 1} point per SAR spent`}
                      </Text>
                    </View>
                  </LinearGradient>
                </View>
              );
            })()}

            {/* Stamp Card */}
            {balance?.stampEnabled && (
              <View
                className="mt-5 p-5 rounded-2xl"
                style={{
                  backgroundColor: menuCardColor,
                  borderWidth: 1, borderColor: '#e2e8f0',
                  shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
                  shadowOpacity: 0.06, shadowRadius: 8, elevation: 3,
                }}
              >
                <Text className="font-bold text-slate-800 mb-3">Stamp Card</Text>
                <View className="flex-row flex-wrap gap-2">
                  {Array.from({ length: balance.stampTarget }).map((_, i) => (
                    <View
                      key={i}
                      className="w-9 h-9 rounded-full items-center justify-center"
                      style={{
                        backgroundColor: i < (balance.stamps ?? 0) ? primaryColor : '#e2e8f0',
                      }}
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
                  {(balance.stampTarget - (balance.stamps ?? 0))} more orders until: {balance.stampRewardDescription}
                </Text>
                {(balance.completedCards ?? 0) > 0 && (
                  <Text className="text-emerald-600 text-xs mt-1 font-semibold">
                    Cards completed: {balance.completedCards}
                  </Text>
                )}
              </View>
            )}

            {/* Add to Apple Wallet */}
            {appleWalletAvailable && user?.id && merchantId && Platform.OS === 'ios' && (
              <TouchableOpacity
                onPress={async () => {
                  try {
                    let PassKit: any;
                    try {
                      const mod = require('react-native-passkit-wallet');
                      PassKit = mod.default || mod;
                    } catch {
                      Alert.alert('Build Required', 'This feature requires a newer app build. Please update the app.');
                      return;
                    }
                    if (!PassKit || typeof PassKit.canAddPasses !== 'function') {
                      Alert.alert('Build Required', 'This feature requires a newer app build. Please update the app.');
                      return;
                    }
                    const canAdd = await PassKit.canAddPasses();
                    if (!canAdd) {
                      Alert.alert('Not Supported', 'Apple Wallet is not available on this device.');
                      return;
                    }
                    const url = `${API_URL}/api/loyalty/wallet-pass?customerId=${encodeURIComponent(user.id)}&merchantId=${encodeURIComponent(merchantId)}`;
                    const filePath = `${FileSystem.cacheDirectory}loyalty-card.pkpass`;
                    const download = await FileSystem.downloadAsync(url, filePath);
                    if (download.status !== 200) {
                      Alert.alert('Error', 'Could not download wallet pass.');
                      return;
                    }
                    const base64 = await FileSystem.readAsStringAsync(filePath, {
                      encoding: FileSystem.EncodingType.Base64,
                    });
                    await PassKit.addPass(base64);
                  } catch (err: any) {
                    Alert.alert('Error', err?.message || 'Could not add wallet pass.');
                  }
                }}
                className="mt-5 flex-row items-center justify-center py-3.5 rounded-2xl"
                style={{ backgroundColor: '#000' }}
              >
                <Text className="text-white text-base font-semibold">Add to Apple Wallet</Text>
              </TouchableOpacity>
            )}

            {/* Add to Google Wallet */}
            {googleWalletAvailable && user?.id && merchantId && (
              <TouchableOpacity
                onPress={async () => {
                  try {
                    const res = await fetch(
                      `${API_URL}/api/loyalty/google-wallet?customerId=${encodeURIComponent(user.id)}&merchantId=${encodeURIComponent(merchantId)}`
                    );
                    const data = await res.json();
                    if (data.saveUrl) {
                      Linking.openURL(data.saveUrl);
                    } else {
                      Alert.alert('Error', data.error || 'Could not generate Google Wallet pass.');
                    }
                  } catch {
                    Alert.alert('Error', 'Failed to connect to server.');
                  }
                }}
                className="mt-5 flex-row items-center justify-center py-3.5 rounded-2xl"
                style={{ backgroundColor: '#000' }}
              >
                <Text className="text-white text-base font-semibold">Add to Google Wallet</Text>
              </TouchableOpacity>
            )}

            {/* Rewards Catalog */}
            {rewards.length > 0 && (
              <View className="mt-5">
                <Text className="text-lg font-bold mb-3" style={{ color: textColor }}>Rewards</Text>
                {rewards.map((r) => (
                  <View
                    key={r.id}
                    className="flex-row items-center mb-3 p-4 rounded-2xl"
                    style={{ backgroundColor: menuCardColor, borderWidth: 1, borderColor: '#e2e8f0' }}
                  >
                    {r.image_url ? (
                      <Image source={{ uri: r.image_url }} className="w-14 h-14 rounded-xl mr-3" resizeMode="cover" />
                    ) : (
                      <View className="w-14 h-14 rounded-xl mr-3 bg-slate-100 items-center justify-center">
                        <Gift size={24} color={primaryColor} />
                      </View>
                    )}
                    <View className="flex-1">
                      <Text className="font-semibold text-sm" style={{ color: textColor }}>{r.name}</Text>
                      {r.description && <Text className="text-xs text-slate-400 mt-0.5">{r.description}</Text>}
                      <Text className="text-xs font-bold mt-1" style={{ color: primaryColor }}>
                        {r.points_cost} points
                      </Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => handleRedeemReward(r)}
                      disabled={redeemingId === r.id || (balance?.points ?? 0) < r.points_cost}
                      className="px-4 py-2 rounded-xl"
                      style={{
                        backgroundColor: (balance?.points ?? 0) >= r.points_cost ? primaryColor : '#e2e8f0',
                        opacity: redeemingId === r.id ? 0.5 : 1,
                      }}
                    >
                      <Text
                        className="text-xs font-bold"
                        style={{ color: (balance?.points ?? 0) >= r.points_cost ? '#fff' : '#94a3b8' }}
                      >
                        {redeemingId === r.id ? '...' : 'Redeem'}
                      </Text>
                    </TouchableOpacity>
                  </View>
                ))}
              </View>
            )}

            {/* Transaction History */}
            <View className="mt-5">
              <TouchableOpacity
                onPress={() => setShowHistory(!showHistory)}
                className="flex-row items-center justify-between mb-3"
              >
                <Text className="text-lg font-bold" style={{ color: textColor }}>Recent Activity</Text>
                <ChevronDown
                  size={20}
                  color="#64748b"
                  style={{ transform: [{ rotate: showHistory ? '180deg' : '0deg' }] }}
                />
              </TouchableOpacity>
              {showHistory && (
                transactions.length > 0 ? (
                  transactions.map((tx) => (
                    <View key={tx.id} className="flex-row items-center py-3 border-b border-slate-100">
                      <View
                        className="w-9 h-9 rounded-full items-center justify-center"
                        style={{ backgroundColor: tx.type === 'earn' ? '#dcfce7' : '#fef3c7' }}
                      >
                        {tx.type === 'earn' ? (
                          <TrendingUp size={16} color="#16a34a" />
                        ) : (
                          <Gift size={16} color="#d97706" />
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
                    No transactions yet. Make an order to earn points!
                  </Text>
                )
              )}
            </View>
          </ScrollView>
        )
      )}
    </View>
  );
}
