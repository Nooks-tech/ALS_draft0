import { useRouter } from 'expo-router';
import { Award, ChevronDown, Gift, Star, TrendingUp, X } from 'lucide-react-native';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { loyaltyApi, type LoyaltyBalance, type LoyaltyTransaction } from '../src/api/loyalty';
import { useAuth } from '../src/context/AuthContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function LoyaltyModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { user } = useAuth();
  const [balance, setBalance] = useState<LoyaltyBalance | null>(null);
  const [transactions, setTransactions] = useState<LoyaltyTransaction[]>([]);
  const [loading, setLoading] = useState(true);
  const [showHistory, setShowHistory] = useState(false);

  useEffect(() => {
    if (!user?.id) return;
    let cancelled = false;
    Promise.all([
      loyaltyApi.getBalance(user.id).catch(() => null),
      loyaltyApi.getHistory(user.id).catch(() => ({ transactions: [] })),
    ]).then(([bal, hist]) => {
      if (cancelled) return;
      if (bal) setBalance(bal);
      if (hist) setTransactions(hist.transactions);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [user?.id]);

  const tierName = !balance ? 'Bronze' :
    balance.lifetimePoints >= 5000 ? 'Gold' :
    balance.lifetimePoints >= 1000 ? 'Silver' : 'Bronze';

  const tierColor = tierName === 'Gold' ? '#F59E0B' : tierName === 'Silver' ? '#94A3B8' : '#CD7F32';
  const nextTier = tierName === 'Gold' ? null : tierName === 'Silver' ? { name: 'Gold', points: 5000 } : { name: 'Silver', points: 1000 };
  const progress = nextTier ? Math.min(100, ((balance?.lifetimePoints ?? 0) / nextTier.points) * 100) : 100;

  return (
    <SafeAreaView className="flex-1 bg-white">
      <View className="flex-row items-center justify-between px-5 py-4 border-b border-slate-100">
        <Text className="text-lg font-bold text-slate-800">Loyalty Points</Text>
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
          <View className="mx-5 mt-5 p-6 rounded-3xl" style={{ backgroundColor: primaryColor }}>
            <View className="flex-row items-center mb-4">
              <Star size={24} color="white" fill="white" />
              <Text className="text-white text-lg font-bold ml-2">Your Points</Text>
            </View>
            <Text className="text-white text-5xl font-bold">{balance?.points ?? 0}</Text>
            <Text className="text-white/70 mt-1">
              Worth {balance?.pointsValue?.toFixed(2) ?? '0.00'} SAR
            </Text>

            <View className="mt-6 flex-row items-center">
              <Award size={18} color={tierColor} />
              <Text className="text-white font-bold ml-2">{tierName} Member</Text>
            </View>
            {nextTier && (
              <View className="mt-3">
                <View className="flex-row justify-between mb-1">
                  <Text className="text-white/70 text-xs">{balance?.lifetimePoints ?? 0} pts</Text>
                  <Text className="text-white/70 text-xs">{nextTier.points} pts for {nextTier.name}</Text>
                </View>
                <View className="h-2 bg-white/20 rounded-full overflow-hidden">
                  <View className="h-full rounded-full bg-white" style={{ width: `${progress}%` }} />
                </View>
              </View>
            )}
          </View>

          {/* How it works */}
          <View className="mx-5 mt-6">
            <Text className="text-lg font-bold text-slate-800 mb-4">How it works</Text>
            <View className="flex-row gap-4">
              <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                <TrendingUp size={24} color={primaryColor} />
                <Text className="text-slate-800 font-bold mt-2 text-center">Earn</Text>
                <Text className="text-slate-500 text-xs text-center mt-1">
                  {balance?.pointsPerSar ?? 1} point per SAR spent
                </Text>
              </View>
              <View className="flex-1 bg-slate-50 rounded-2xl p-4 items-center">
                <Gift size={24} color={primaryColor} />
                <Text className="text-slate-800 font-bold mt-2 text-center">Redeem</Text>
                <Text className="text-slate-500 text-xs text-center mt-1">
                  Each point = {balance?.pointValueSar ?? 0.1} SAR
                </Text>
              </View>
            </View>
          </View>

          {/* Transaction History */}
          <View className="mx-5 mt-6">
            <TouchableOpacity
              onPress={() => setShowHistory(!showHistory)}
              className="flex-row items-center justify-between mb-3"
            >
              <Text className="text-lg font-bold text-slate-800">Recent Activity</Text>
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
                <Text className="text-slate-400 text-center py-4">No transactions yet. Make an order to earn points!</Text>
              )
            )}
          </View>

          {/* Lifetime stats */}
          <View className="mx-5 mt-6 bg-slate-50 rounded-2xl p-5">
            <Text className="font-bold text-slate-800 mb-3">Lifetime Stats</Text>
            <View className="flex-row justify-between">
              <View>
                <Text className="text-slate-500 text-xs">Total Earned</Text>
                <Text className="text-slate-800 font-bold text-lg">{balance?.lifetimePoints ?? 0}</Text>
              </View>
              <View>
                <Text className="text-slate-500 text-xs">Points Used</Text>
                <Text className="text-slate-800 font-bold text-lg">
                  {(balance?.lifetimePoints ?? 0) - (balance?.points ?? 0)}
                </Text>
              </View>
              <View>
                <Text className="text-slate-500 text-xs">Available</Text>
                <Text className="font-bold text-lg" style={{ color: primaryColor }}>{balance?.points ?? 0}</Text>
              </View>
            </View>
          </View>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}
