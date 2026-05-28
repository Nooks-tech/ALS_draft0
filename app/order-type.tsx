import { ArrowLeft, Bike, Car, MapPin, Pencil, Plus, Store, Trash2 } from 'lucide-react-native';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Dimensions, KeyboardAvoidingView, Platform, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { useCart } from '../src/context/CartContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';
import { useMenuContext } from '../src/context/MenuContext';
import { useOperations } from '../src/context/OperationsContext';
import { useSavedAddresses } from '../src/context/SavedAddressesContext';
import { SwipeableBottomSheet } from '../src/components/common/SwipeableBottomSheet';
import { MonoText, PolaroidCard } from '../src/layouts/polaroid/PolaroidCard';
import { POLAROID_FONT, resolvePolaroidColors, rotationForIndex } from '../src/layouts/polaroid/styles';

const SCREEN_HEIGHT = Dimensions.get('window').height;

export default function OrderTypeScreen() {
  const router = useRouter();
  const { i18n } = useTranslation();
  const insets = useSafeAreaInsets();
  const { primaryColor, menuLayout, layoutColors } = useMerchantBranding();
  const isPolaroid = menuLayout === 'polaroid';
  const polaroid = useMemo(() => resolvePolaroidColors(layoutColors), [layoutColors]);
  const { orderType, setOrderType, selectedBranch, setSelectedBranch, setDeliveryAddress } = useCart();
  const { branches } = useMenuContext();
  const { isClosed, isBusy, isPickupOnly, deliveryEnabled, pickupEnabled, drivethruEnabled } = useOperations();
  const { addresses: savedAddresses, setDefault, updateAddress, removeAddress } = useSavedAddresses();
  const [step, setStep] = useState<'choice' | 'branch' | 'map'>('choice');
  const isArabic = i18n.language === 'ar';

  const handleSelectBranch = (branch: (typeof branches)[0]) => {
    setSelectedBranch(branch);
    if (orderType === 'delivery') {
      setStep('map');
    } else {
      router.back();
    }
  };

  /** Parse distance string like "1.5 km" to number for sorting. */
  const parseDistance = (d: string | undefined): number => {
    if (!d) return Infinity;
    const m = d.match(/([\d.]+)\s*km?/i);
    return m ? parseFloat(m[1]) : Infinity;
  };

  const sortedBranches = useMemo(
    () => [...branches].sort((a, b) => parseDistance(a.distance) - parseDistance(b.distance)),
    [branches],
  );

  const handleDelivery = () => {
    setOrderType('delivery');
    const closest = sortedBranches[0];
    if (closest) setSelectedBranch(closest);
    setStep('map');
  };

  const modalHeight = SCREEN_HEIGHT * 0.65;

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1 }}
      keyboardVerticalOffset={Platform.OS === 'ios' ? 0 : 20}
    >
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <SwipeableBottomSheet
        onDismiss={() => router.back()}
        height={modalHeight}
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: isPolaroid ? polaroid.bg : 'white',
          borderTopLeftRadius: isPolaroid ? 28 : 40,
          borderTopRightRadius: isPolaroid ? 28 : 40,
          overflow: 'hidden',
          paddingBottom: insets.bottom,
        }}
      >
        <View
          className={isPolaroid ? "px-5 py-4 flex-row items-center justify-between" : "px-5 py-4 flex-row items-center justify-between border-b border-slate-100"}
          style={isPolaroid ? { borderBottomWidth: 1, borderBottomColor: `${polaroid.text}1A` } : undefined}
        >
        <TouchableOpacity
          onPress={() => {
            if (step === 'choice') router.back();
            else if (step === 'map' && orderType === 'delivery') setStep('branch');
            else setStep('choice');
          }}
          className={isPolaroid ? "p-2 rounded-full" : "bg-slate-100 p-2 rounded-full"}
          style={isPolaroid ? { backgroundColor: `${polaroid.text}14`, borderWidth: 1, borderColor: `${polaroid.text}22` } : undefined}
        >
          <ArrowLeft size={22} color={isPolaroid ? polaroid.text : '#334155'} />
        </TouchableOpacity>
        {isPolaroid ? (
          <Text
            style={{
              fontFamily: POLAROID_FONT.serif,
              fontStyle: 'italic',
              fontSize: 18,
              color: polaroid.text,
            }}
          >
            {step === 'choice' ? (isArabic ? 'نوع الطلب' : 'Order Type') : step === 'branch' ? (isArabic ? 'اختر الفرع' : 'Select Branch') : (isArabic ? 'عنوان التوصيل' : 'Delivery Address')}
          </Text>
        ) : (
          <Text className="text-lg font-bold text-slate-800">
            {step === 'choice' ? (isArabic ? 'نوع الطلب' : 'Order Type') : step === 'branch' ? (isArabic ? 'اختر الفرع' : 'Select Branch') : (isArabic ? 'عنوان التوصيل' : 'Delivery Address')}
          </Text>
        )}
        <View className="w-10" />
      </View>
      {step === 'map' ? (
        <View className="flex-1" style={{ paddingHorizontal: 20, paddingTop: 16 }}>
          <Text className="text-2xl font-bold text-slate-900 mb-4">{isArabic ? 'عنوان التوصيل' : 'Delivery Address'}</Text>
          <ScrollView
            className="flex-1"
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{ paddingBottom: 8 }}
            keyboardShouldPersistTaps="handled"
          >
            {savedAddresses.length > 0 ? (
              <View>
                <Text className="text-slate-600 font-bold text-sm mb-2">{isArabic ? 'العناوين المحفوظة' : 'Saved locations'}</Text>
                {savedAddresses.map((addr) => {
                  const label = addr.label === 'Other' && addr.customLabel ? addr.customLabel : addr.label;
                  const selectAddress = () => {
                    setDeliveryAddress({ address: addr.address, lat: addr.lat, lng: addr.lng, city: addr.city });
                    router.back();
                  };
                  return (
                    <TouchableOpacity
                      key={addr.id}
                      onPress={selectAddress}
                      activeOpacity={0.8}
                      className="p-4 mb-2 rounded-2xl border bg-slate-50 border-slate-100"
                    >
                      <View className="flex-row items-center">
                        <View className="p-2 rounded-xl me-3 bg-slate-200">
                          <MapPin size={18} color="#64748b" />
                        </View>
                        <View className="flex-1">
                          <View className="flex-row items-center gap-2">
                            <Text className="font-bold text-slate-800">{label}</Text>
                            {addr.isDefault && (
                              <View className="px-1.5 py-0.5 rounded" style={{ backgroundColor: primaryColor }}>
                                <Text className="text-white text-[10px] font-bold">{isArabic ? 'افتراضي' : 'Default'}</Text>
                              </View>
                            )}
                          </View>
                          <Text className="text-slate-500 text-sm" numberOfLines={1}>{addr.address}</Text>
                        </View>
                      </View>
                      <View className="flex-row items-center justify-between mt-3 pt-2 border-t border-slate-200">
                        {!addr.isDefault && (
                          <TouchableOpacity
                            onPress={() => setDefault(addr.id)}
                            style={{ backgroundColor: `${primaryColor}18` }}
                            className="px-3 py-2 rounded-lg"
                          >
                            <Text className="font-bold text-sm" style={{ color: primaryColor }}>{isArabic ? 'تعيين كافتراضي' : 'Set as default'}</Text>
                          </TouchableOpacity>
                        )}
                        <View className="flex-row gap-3 ml-auto">
                          <TouchableOpacity
                            onPress={() => router.push(`/add-address-modal?from=delivery&edit=${addr.id}`)}
                            className="p-2.5"
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Pencil size={20} color="#64748b" />
                          </TouchableOpacity>
                          <TouchableOpacity
                            onPress={() => removeAddress(addr.id)}
                            className="p-2.5"
                            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          >
                            <Trash2 size={20} color="#ef4444" />
                          </TouchableOpacity>
                        </View>
                      </View>
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : (
              <View className="py-4" />
            )}
          </ScrollView>
          <TouchableOpacity
            onPress={() => router.push('/add-address-modal?from=delivery')}
            className="flex-row items-center justify-center p-4 mt-2 border-2 border-dashed border-slate-200 rounded-2xl"
          >
            <Plus size={20} color={primaryColor} />
            <Text className="font-bold ms-2" style={{ color: primaryColor }}>{isArabic ? 'إضافة موقع جديد' : 'Add new location'}</Text>
          </TouchableOpacity>
        </View>
      ) : (
      <ScrollView
        contentContainerStyle={{ paddingHorizontal: 20, paddingTop: 16, paddingBottom: 200 }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {step === 'choice' && isPolaroid && (
          <PolaroidChoice
            polaroid={polaroid}
            isArabic={isArabic}
            isClosed={isClosed}
            isBusy={isBusy}
            isPickupOnly={isPickupOnly}
            deliveryEnabled={deliveryEnabled}
            pickupEnabled={pickupEnabled}
            drivethruEnabled={drivethruEnabled}
            onDelivery={handleDelivery}
            onPickup={() => { setOrderType('pickup'); setStep('branch'); }}
            onDrivethru={() => { setOrderType('drivethru'); setStep('branch'); }}
          />
        )}
        {step === 'choice' && !isPolaroid && (
          <View>
            <Text className="text-2xl font-bold text-slate-900 mb-6">{isArabic ? 'كيف تود استلامه؟' : "How'll you have it?"}</Text>
            {(isClosed || isBusy) && (
              <View className="mb-4 p-4 rounded-2xl bg-amber-50 border border-amber-200">
                <Text className="font-bold text-amber-800">{isClosed ? (isArabic ? 'المتجر مغلق حالياً' : 'Store is currently closed') : (isArabic ? 'المتجر مشغول حالياً' : 'Store is currently busy')}</Text>
                <Text className="text-amber-700 text-sm mt-1">
                  {isClosed
                    ? (isArabic ? 'يمكنك الاستمرار في تصفح القائمة، وستتوفر الطلبات عند إعادة الافتتاح.' : 'You can still browse the menu. Orders will be available when we reopen.')
                    : (isArabic ? 'يمكنك الاستمرار في تصفح القائمة، لكن الطلبات الجديدة متوقفة مؤقتاً.' : 'You can still browse the menu. New orders are temporarily paused.')}
                </Text>
              </View>
            )}
            {/* Order-type options are gated by the merchant's per-branch
                enable flags. Each option just hides when its flag is off
                — the merchant might disable a type at one branch and
                keep it on at another, so customers see different menus
                per merchant install but always see SOMETHING. Legacy
                isPickupOnly is still respected as a fallback for the
                delivery flag. */}
            {!isPickupOnly && deliveryEnabled && (
              <TouchableOpacity
                onPress={handleDelivery}
                disabled={isClosed || isBusy}
                className={`flex-row items-center p-5 rounded-[28px] mb-4 border border-slate-100 shadow-sm ${(isClosed || isBusy) ? 'bg-slate-100 opacity-60' : 'bg-slate-50'}`}
              >
                <View className="p-4 rounded-2xl" style={{ backgroundColor: `${primaryColor}20` }}><Bike size={28} color={primaryColor} /></View>
                <View className="ms-4 flex-1">
                  <Text className="text-lg font-bold text-slate-800">{isArabic ? 'التوصيل' : 'Delivery'}</Text>
                  <Text className="text-slate-500 text-xs">{isArabic ? 'حتى باب منزلك' : 'Direct to your doorstep'}</Text>
                </View>
              </TouchableOpacity>
            )}
            {pickupEnabled && (
              <TouchableOpacity
                onPress={() => { setOrderType('pickup'); setStep('branch'); }}
                disabled={isClosed || isBusy}
                className={`flex-row items-center p-5 rounded-[28px] bg-slate-50 border border-slate-100 shadow-sm mb-4 ${(isClosed || isBusy) ? 'opacity-60' : ''}`}
              >
                <View className="bg-orange-100 p-4 rounded-2xl"><Store size={28} color="#F59E0B" /></View>
                <View className="ms-4 flex-1">
                  <Text className="text-lg font-bold text-slate-800">{isArabic ? 'الاستلام من الفرع' : 'In-Store Pickup'}</Text>
                  <Text className="text-slate-500 text-xs">{isArabic ? 'تجاوز الانتظار واستلمه طازجاً' : 'Skip the line & grab it fresh'}</Text>
                </View>
              </TouchableOpacity>
            )}
            {/* Curbside — internally stored as orderType='drivethru'
                (Foodics has no curbside slot). The customer picks a
                branch the same way pickup does; checkout.tsx then
                shows a 4-field car-info form (plate letters +
                numbers, model, color). */}
            {drivethruEnabled && (
              <TouchableOpacity
                onPress={() => { setOrderType('drivethru'); setStep('branch'); }}
                disabled={isClosed || isBusy}
                className={`flex-row items-center p-5 rounded-[28px] bg-slate-50 border border-slate-100 shadow-sm ${(isClosed || isBusy) ? 'opacity-60' : ''}`}
              >
                <View className="bg-sky-100 p-4 rounded-2xl"><Car size={28} color="#0284c7" /></View>
                <View className="ms-4 flex-1">
                  <Text className="text-lg font-bold text-slate-800">{isArabic ? 'استلام من السيارة' : 'Receive from your car'}</Text>
                  <Text className="text-slate-500 text-xs">{isArabic ? 'نوصله إلى سيارتك في الموقف' : "We'll bring it to your car"}</Text>
                </View>
              </TouchableOpacity>
            )}
            {/* All three types disabled — extremely rare, but if a
                merchant misconfigures we still want a clear message
                instead of a blank screen. */}
            {!deliveryEnabled && !pickupEnabled && !drivethruEnabled && (
              <View className="p-5 rounded-[28px] bg-amber-50 border border-amber-200">
                <Text className="font-bold text-amber-800">
                  {isArabic ? 'لا توجد طرق طلب متاحة' : 'No order types available'}
                </Text>
                <Text className="text-amber-700 text-sm mt-1">
                  {isArabic
                    ? 'هذا الفرع لا يقبل طلبات حالياً. جرّب فرع آخر أو رجاء حاول لاحقاً.'
                    : "This branch isn't taking orders right now. Try another branch or come back later."}
                </Text>
              </View>
            )}
          </View>
        )}

        {step === 'branch' && isPolaroid && (
          <PolaroidBranches
            polaroid={polaroid}
            isArabic={isArabic}
            branches={sortedBranches}
            selectedId={selectedBranch?.id ?? null}
            onPick={handleSelectBranch}
          />
        )}
        {step === 'branch' && !isPolaroid && (
          <View className="pb-8">
            <Text className="text-2xl font-bold mb-6">{isArabic ? 'اختر الفرع' : 'Select Branch'}</Text>
            {sortedBranches.map((b) => (
                <TouchableOpacity
                  key={b.id}
                  onPress={() => handleSelectBranch(b)}
                  style={selectedBranch?.id === b.id ? { backgroundColor: `${primaryColor}12`, borderColor: `${primaryColor}40` } : undefined}
                    className={`p-5 rounded-3xl mb-3 flex-row items-center border ${selectedBranch?.id === b.id ? '' : 'bg-slate-50 border-slate-100'}`}
                >
                  <View style={selectedBranch?.id === b.id ? { backgroundColor: primaryColor } : undefined} className={`p-3 rounded-xl mr-4 ${selectedBranch?.id === b.id ? '' : 'bg-slate-200'}`}>
                    <MapPin size={20} color={selectedBranch?.id === b.id ? 'white' : '#64748b'} />
                  </View>
                  <View className="flex-1">
                    <Text className="font-bold text-lg text-slate-800">{b.name}</Text>
                    <Text className="text-slate-500 text-xs">{b.address}</Text>
                  </View>
                  <Text className="font-bold text-xs" style={{ color: primaryColor }}>{b.distance}</Text>
                </TouchableOpacity>
              ))}
          </View>
        )}

      </ScrollView>
      )}
      </SwipeableBottomSheet>
    </KeyboardAvoidingView>
  );
}

/* ────────── Polaroid bottom-sheet body ────────── */

type PolaroidColors = ReturnType<typeof resolvePolaroidColors>;

function PolaroidPanel({ children }: { polaroid: PolaroidColors; children: React.ReactNode }) {
  // The sheet chrome itself is already polaroid bg (set on
  // SwipeableBottomSheet's style), so the inner body just needs
  // breathing room — no nested kraft layer.
  return <View>{children}</View>;
}

function PolaroidChoice({
  polaroid,
  isArabic,
  isClosed,
  isBusy,
  isPickupOnly,
  deliveryEnabled,
  pickupEnabled,
  drivethruEnabled,
  onDelivery,
  onPickup,
  onDrivethru,
}: {
  polaroid: PolaroidColors;
  isArabic: boolean;
  isClosed: boolean;
  isBusy: boolean;
  isPickupOnly: boolean;
  deliveryEnabled: boolean;
  pickupEnabled: boolean;
  drivethruEnabled: boolean;
  onDelivery: () => void;
  onPickup: () => void;
  onDrivethru: () => void;
}) {
  const disabled = isClosed || isBusy;
  const rows: Array<{ key: string; show: boolean; emoji: string; titleEn: string; titleAr: string; subEn: string; subAr: string; onPress: () => void }> = [
    { key: 'pickup', show: pickupEnabled, emoji: '🥡', titleEn: 'In-Store Pickup', titleAr: 'استلام من الفرع', subEn: 'Skip the line', subAr: 'تجاوز الانتظار', onPress: onPickup },
    { key: 'delivery', show: !isPickupOnly && deliveryEnabled, emoji: '🛵', titleEn: 'Delivery', titleAr: 'التوصيل', subEn: 'To your doorstep', subAr: 'حتى باب منزلك', onPress: onDelivery },
    { key: 'drivethru', show: drivethruEnabled, emoji: '🚗', titleEn: 'From the car', titleAr: 'استلام من السيارة', subEn: 'Curbside pickup', subAr: 'استلام أمام الفرع', onPress: onDrivethru },
  ].filter((r) => r.show);

  return (
    <PolaroidPanel polaroid={polaroid}>
      <MonoText size={22} color={polaroid.text} style={{ fontFamily: POLAROID_FONT.serif, fontStyle: 'italic' }}>
        {isArabic ? 'كيف تود استلامه؟' : "How'll you have it?"}
      </MonoText>
      <MonoText size={9} tracking={1.8} uppercase color={`${polaroid.text}66`} style={{ marginTop: 4 }}>
        {isArabic ? 'اختر طريقة الاستلام' : 'Pick a pickup style'}
      </MonoText>

      {disabled && (
        <View style={{ marginTop: 14 }}>
          <PolaroidCard rotation="-0.6deg" surfaceColor={polaroid.stampRed} style={{ paddingVertical: 12, paddingHorizontal: 14 }}>
            <MonoText size={10} tracking={1.8} uppercase weight="800" color="#ffffff">
              {isClosed ? (isArabic ? 'المتجر مغلق' : 'Store closed') : (isArabic ? 'المتجر مشغول' : 'Store busy')}
            </MonoText>
            <MonoText size={9} color="#ffffff" style={{ marginTop: 4, opacity: 0.85 }}>
              {isClosed
                ? (isArabic ? 'تصفح القائمة الآن، والطلبات تفتح عند إعادة الافتتاح' : 'Browse now; orders reopen when we do')
                : (isArabic ? 'الطلبات الجديدة متوقفة مؤقتاً' : 'New orders paused briefly')}
            </MonoText>
          </PolaroidCard>
        </View>
      )}

      <View style={{ marginTop: 18 }}>
        {rows.map((r, i) => (
          <View key={r.key} style={{ marginBottom: 14, opacity: disabled ? 0.55 : 1 }}>
            <PolaroidCard rotation={rotationForIndex(i)} large style={{ padding: 12 }}>
              <TouchableOpacity activeOpacity={0.85} onPress={disabled ? undefined : r.onPress} disabled={disabled}>
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View
                    style={{
                      width: 56,
                      height: 56,
                      backgroundColor: '#e7e2d6',
                      alignItems: 'center',
                      justifyContent: 'center',
                      marginEnd: 14,
                    }}
                  >
                    <MonoText size={32} color={polaroid.textOnSurface}>{r.emoji}</MonoText>
                  </View>
                  <View style={{ flex: 1 }}>
                    <MonoText size={13} weight="700" tracking={0.4} color={polaroid.textOnSurface}>
                      {isArabic ? r.titleAr : r.titleEn}
                    </MonoText>
                    <MonoText size={9} tracking={1.4} uppercase color={`${polaroid.textOnSurface}88`} style={{ marginTop: 4 }}>
                      {isArabic ? r.subAr : r.subEn}
                    </MonoText>
                  </View>
                  <View
                    style={{
                      width: 32, height: 32, borderRadius: 999,
                      backgroundColor: polaroid.accent,
                      alignItems: 'center', justifyContent: 'center',
                    }}
                  >
                    <MonoText size={14} color="#ffffff" weight="800">›</MonoText>
                  </View>
                </View>
              </TouchableOpacity>
            </PolaroidCard>
          </View>
        ))}

        {rows.length === 0 && (
          <PolaroidCard rotation="0.4deg" surfaceColor={polaroid.stampRed} style={{ padding: 14 }}>
            <MonoText size={11} tracking={1.4} uppercase weight="800" color="#ffffff">
              {isArabic ? 'لا توجد طرق طلب متاحة' : 'No order types available'}
            </MonoText>
          </PolaroidCard>
        )}
      </View>
    </PolaroidPanel>
  );
}

function PolaroidBranches({
  polaroid,
  isArabic,
  branches,
  selectedId,
  onPick,
}: {
  polaroid: PolaroidColors;
  isArabic: boolean;
  branches: Array<{ id: string; name: string; address: string; distance?: string }>;
  selectedId: string | null;
  onPick: (b: { id: string; name: string; address: string; distance?: string }) => void;
}) {
  return (
    <PolaroidPanel polaroid={polaroid}>
      <MonoText size={22} color={polaroid.text} style={{ fontFamily: POLAROID_FONT.serif, fontStyle: 'italic' }}>
        {isArabic ? 'اختر الفرع' : 'Pick a branch'}
      </MonoText>
      <MonoText size={9} tracking={1.8} uppercase color={`${polaroid.text}66`} style={{ marginTop: 4 }}>
        {isArabic ? 'ادرس المسافة' : 'Closest first'}
      </MonoText>

      <View style={{ marginTop: 18 }}>
        {branches.map((b, i) => {
          const isOn = b.id === selectedId;
          return (
            <View key={b.id} style={{ marginBottom: 12 }}>
              <PolaroidCard
                rotation={rotationForIndex(i)}
                surfaceColor={isOn ? polaroid.accent : polaroid.surface}
                style={{ padding: 12 }}
              >
                <TouchableOpacity activeOpacity={0.85} onPress={() => onPick(b)}>
                  <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <View
                      style={{
                        width: 36, height: 36, borderRadius: 999,
                        backgroundColor: isOn ? '#ffffff22' : `${polaroid.textOnSurface}11`,
                        alignItems: 'center', justifyContent: 'center', marginEnd: 12,
                      }}
                    >
                      <MapPin size={18} color={isOn ? '#ffffff' : polaroid.textOnSurface} />
                    </View>
                    <View style={{ flex: 1 }}>
                      <MonoText size={13} weight="700" color={isOn ? '#ffffff' : polaroid.textOnSurface} numberOfLines={1}>
                        {b.name}
                      </MonoText>
                      <MonoText size={9} tracking={1.2} uppercase color={isOn ? '#ffffffaa' : `${polaroid.textOnSurface}88`} style={{ marginTop: 2 }} numberOfLines={1}>
                        {b.address}
                      </MonoText>
                    </View>
                    {!!b.distance && (
                      <MonoText size={10} tracking={1.4} weight="800" color={isOn ? '#ffffff' : polaroid.accent}>
                        {b.distance}
                      </MonoText>
                    )}
                  </View>
                </TouchableOpacity>
              </PolaroidCard>
            </View>
          );
        })}
      </View>
    </PolaroidPanel>
  );
}
