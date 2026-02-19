import { ScrollView, Text, TouchableOpacity, View } from 'react-native';

interface CategoryListProps {
  categories: string[];
  selectedCategory: string;
  onSelectCategory: (category: string) => void;
}

export const CategoryList = ({ categories, selectedCategory, onSelectCategory }: CategoryListProps) => {
  return (
    <View>
      <ScrollView 
        horizontal 
        showsHorizontalScrollIndicator={false} 
        contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 10 }}
      >
        {categories.map((category, index) => {
          const isSelected = selectedCategory === category;
          return (
            <TouchableOpacity 
              key={index} 
              onPress={() => onSelectCategory(category)}
              className={`mr-3 px-5 py-2 rounded-full border ${
                isSelected 
                  ? 'bg-[#FF5A5F] border-[#FF5A5F]' 
                  : 'bg-white border-gray-200'
              }`}
            >
              <Text 
                className={`font-bold ${
                  isSelected ? 'text-white' : 'text-gray-600'
                }`}
              >
                {category}
              </Text>
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};