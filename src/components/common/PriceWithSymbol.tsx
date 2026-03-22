import { I18nManager, Text, View } from 'react-native';
import { SaudiRiyalIcon } from './SaudiRiyalIcon';

type Props = {
  amount?: number | string;
  iconSize?: number;
  iconColor?: string;
  textStyle?: object;
  className?: string;
  prefix?: string;
  symbolOnly?: boolean;
};

export function PriceWithSymbol({ amount, iconSize = 16, iconColor, textStyle, className, prefix = '', symbolOnly = false }: Props) {
  const isRTL = I18nManager.isRTL;
  const displayAmount = amount != null
    ? (typeof amount === 'number' ? amount.toFixed(amount % 1 === 0 ? 0 : 2) : amount)
    : '';
  return (
    <View
      className={`items-center ${className ?? ''}`}
      style={{ flexDirection: isRTL ? 'row-reverse' : 'row' }}
    >
      {prefix ? <Text style={textStyle}>{prefix}</Text> : null}
      {!symbolOnly && displayAmount !== '' ? <Text style={textStyle}>{displayAmount}</Text> : null}
      {!symbolOnly && displayAmount !== '' ? <View style={isRTL ? { marginRight: 4 } : { marginLeft: 4 }} /> : null}
      <SaudiRiyalIcon size={iconSize} color={iconColor} />
    </View>
  );
}
