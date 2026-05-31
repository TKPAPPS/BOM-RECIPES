import { useState, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api';

export function useIngredientSearch() {
  const [query, setQuery] = useState('');

  const { data: results = [], isFetching } = useQuery({
    queryKey: ['items-search', query],
    queryFn: () => api.searchItems(query),
    enabled: query.trim().length >= 2,
    staleTime: 30_000,
  });

  const onSearch = useCallback((value: string) => {
    setQuery(value);
  }, []);

  return { query, results, isFetching, onSearch };
}
