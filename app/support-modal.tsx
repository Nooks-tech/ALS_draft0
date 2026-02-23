import { useRouter } from 'expo-router';
import { CheckCircle, MessageCircle, X } from 'lucide-react-native';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, Text, TextInput, TouchableOpacity, View } from 'react-native';
import { supabase } from '../src/api/supabase';
import { useAuth } from '../src/context/AuthContext';
import { useMerchant } from '../src/context/MerchantContext';
import { useMerchantBranding } from '../src/context/MerchantBrandingContext';

export default function SupportModal() {
  const router = useRouter();
  const { primaryColor } = useMerchantBranding();
  const { user } = useAuth();
  const { merchantId } = useMerchant();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const handleSend = useCallback(async () => {
    if (!subject.trim() || !message.trim()) {
      Alert.alert('Missing fields', 'Please fill in both subject and message.');
      return;
    }
    setSending(true);
    try {
      if (supabase) {
        await supabase.from('support_tickets').insert({
          merchant_id: merchantId || null,
          customer_id: user?.id ?? null,
          email: user?.email ?? null,
          subject: subject.trim(),
          message: message.trim(),
        });
      }
      setSent(true);
    } catch {
      Alert.alert('Error', 'Could not send your message. Please try again.');
    } finally {
      setSending(false);
    }
  }, [subject, message, user, merchantId]);

  return (
    <View className="flex-1">
      <TouchableOpacity className="absolute inset-0 bg-black/60" activeOpacity={1} onPress={() => router.back()} />
      <View className="absolute bottom-0 left-0 right-0 bg-white rounded-t-[40px] flex-1 max-h-[85%] overflow-hidden">
        <View className="flex-row items-center justify-between px-6 pt-6 pb-4 border-b border-slate-100">
          <Text className="text-xl font-bold text-slate-800">Support</Text>
          <TouchableOpacity onPress={() => router.back()} className="p-2 -mr-2">
            <X size={24} color="#64748b" />
          </TouchableOpacity>
        </View>
        <ScrollView className="flex-1 px-6 py-6" showsVerticalScrollIndicator={false}>
          {sent ? (
            <View className="items-center py-12">
              <CheckCircle size={64} color={primaryColor} />
              <Text className="text-xl font-bold text-slate-800 mt-4">Message Sent</Text>
              <Text className="text-slate-500 text-center mt-2">We'll get back to you within 24 hours.</Text>
              <TouchableOpacity onPress={() => router.back()} className="mt-6 py-3 px-8 rounded-2xl" style={{ backgroundColor: primaryColor }}>
                <Text className="text-white font-bold">Done</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              <View className="items-center mb-6">
                <View className="w-16 h-16 rounded-full justify-center items-center" style={{ backgroundColor: `${primaryColor}20` }}>
                  <MessageCircle size={32} color={primaryColor} />
                </View>
                <Text className="text-slate-600 text-center mt-4">Having an issue? Send us a message and we'll get back to you within 24 hours.</Text>
              </View>
              <View className="mb-4">
                <Text className="text-slate-500 text-sm font-bold mb-2">Subject</Text>
                <TextInput placeholder="How can we help?" className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium" value={subject} onChangeText={setSubject} />
              </View>
              <View className="mb-6">
                <Text className="text-slate-500 text-sm font-bold mb-2">Message</Text>
                <TextInput placeholder="Describe your issue or question..." className="bg-slate-50 px-4 py-3 rounded-2xl text-slate-800 font-medium h-32" multiline textAlignVertical="top" value={message} onChangeText={setMessage} />
              </View>
              <TouchableOpacity
                className="py-4 rounded-2xl items-center"
                style={{ backgroundColor: sending ? '#94a3b8' : primaryColor }}
                onPress={handleSend}
                disabled={sending}
              >
                {sending ? <ActivityIndicator color="white" /> : <Text className="text-white font-bold text-lg">Send Message</Text>}
              </TouchableOpacity>
            </>
          )}
        </ScrollView>
      </View>
    </View>
  );
}
