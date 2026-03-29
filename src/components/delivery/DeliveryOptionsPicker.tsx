import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { otoApi, OTODeliveryOption } from '../../api/oto';
import { useCart } from '../../context/CartContext';
import { getBranchOtoConfig } from '../../config/branchOtoConfig';

type Props = {
  accentColor?: string;
};

export function DeliveryOptionsPicker({ accentColor = '#0D9488' }: Props) {
  const {
    orderType,
    selectedBranch,
    deliveryAddress,
    deliveryOptionId,
    setDeliveryFee,
    setDeliveryOptionId,
    setDeliveryCarrierName,
  } = useCart();

  const [options, setOptions] = useState<OTODeliveryOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (orderType !== 'delivery' || !selectedBranch || !deliveryAddress?.lat) {
      setOptions([]);
      return;
    }

    const branchOto = getBranchOtoConfig(selectedBranch.id, selectedBranch.name);
    const branchCity = branchOto?.city || 'Riyadh';
    const customerCity = deliveryAddress.city || branchCity;

    setLoading(true);
    setError(null);

    otoApi
      .getDeliveryOptions({
        originCity: branchCity,
        destinationCity: customerCity,
        originLat: branchOto?.lat,
        originLon: branchOto?.lon,
        destinationLat: deliveryAddress.lat,
        destinationLon: deliveryAddress.lng,
      })
      .then((res) => {
        const opts = res?.options ?? [];
        setOptions(opts);
        // Auto-select cheapest if nothing selected
        if (opts.length > 0 && !deliveryOptionId) {
          const cheapest = opts.reduce((a, b) => (a.price < b.price ? a : b));
          setDeliveryFee(cheapest.price);
          setDeliveryOptionId(cheapest.deliveryOptionId);
          setDeliveryCarrierName(cheapest.deliveryCompanyName);
        }
      })
      .catch(() => setError('Could not load delivery options'))
      .finally(() => setLoading(false));
  }, [orderType, selectedBranch?.id, deliveryAddress?.lat, deliveryAddress?.lng]);

  if (orderType !== 'delivery' || !deliveryAddress?.lat) return null;

  if (loading) {
    return (
      <View className="py-4 items-center">
        <ActivityIndicator color={accentColor} />
        <Text className="text-slate-500 text-xs mt-2">Loading delivery options...</Text>
      </View>
    );
  }

  if (error) {
    return (
      <View className="py-3 px-4 bg-red-50 rounded-xl mb-3">
        <Text className="text-red-600 text-sm">{error}</Text>
      </View>
    );
  }

  if (options.length === 0) return null;

  return (
    <View className="mb-4">
      <Text className="font-bold text-slate-700 text-sm mb-2">Delivery Carrier</Text>
      <View className="gap-2">
        {options.map((opt) => {
          const selected = deliveryOptionId === opt.deliveryOptionId;
          return (
            <Pressable
              key={opt.deliveryOptionId}
              onPress={() => {
                setDeliveryFee(opt.price);
                setDeliveryOptionId(opt.deliveryOptionId);
                setDeliveryCarrierName(opt.deliveryCompanyName);
              }}
              className={`flex-row items-center justify-between px-4 py-3 rounded-xl border ${
                selected ? 'border-2' : 'border-slate-200 bg-white'
              }`}
              style={selected ? { borderColor: accentColor, backgroundColor: accentColor + '10' } : undefined}
            >
              <View>
                <Text className={`font-semibold text-sm ${selected ? 'text-slate-800' : 'text-slate-600'}`}>
                  {opt.deliveryCompanyName}
                </Text>
                <Text className="text-xs text-slate-400">{opt.avgDeliveryTime}</Text>
              </View>
              <Text className={`font-bold text-sm ${selected ? 'text-slate-800' : 'text-slate-500'}`}>
                {opt.price.toFixed(2)} SAR
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}
