import { useMutation, useQueryClient } from "@tanstack/vue-query"
import { applyFeature, createFeature, removeFeatureApplication, triggerSolrIndex } from "@/api/pim"
import type { FeatureApply, FeatureCreate } from "@/domain/types/pim"
import type { ProductFeatureApplication } from "@/domain/types/product"
import { qk } from "@/queries/keys"
import { DateTime } from "luxon"

/** Feature chip edits: optimistic apply/remove; creating a brand-new feature value first writes the
 *  catalog row (idempotent server-side) then applies it. */
export function useFeatureMutations(productId: () => string, parentProductId: () => string = productId) {
  const queryClient = useQueryClient()
  const listKey = () => qk.product.features(productId())

  const cacheCreatedFeature = (productFeatureId: string, payload: FeatureCreate) => {
    queryClient.setQueryData<Record<string, unknown>[]>(qk.catalog.features(), (rows) => {
      if(!rows || rows.some((row) => row.productFeatureId === productFeatureId)) {return rows}

      return [...rows, {
        productFeatureId,
        productFeatureTypeId: payload.productFeatureTypeId,
        description: payload.description
      }]
    })
  }

  const cacheCreatedFeatureApplication = (
    productFeatureId: string,
    payload: FeatureCreate & { productFeatureApplTypeId?: string },
    fromDate: unknown
  ) => {
    const effectiveFromDate = typeof fromDate === "number"
      ? DateTime.fromMillis(fromDate).toISO()
      : typeof fromDate === "string" ? fromDate : new Date().toISOString()

    queryClient.setQueryData<ProductFeatureApplication[]>(listKey(), (rows = []) => {
      if(rows.some((row) => row.productFeatureId === productFeatureId)) {return rows}

      return [...rows, {
        productId: productId(),
        productFeatureId,
        productFeatureApplTypeId: payload.productFeatureApplTypeId ?? "STANDARD_FEATURE",
        featureTypeId: payload.productFeatureTypeId,
        featureTypeDescription: payload.productFeatureTypeId,
        description: payload.description,
        fromDate: effectiveFromDate ?? new Date().toISOString(),
        thruDate: null,
        active: true,
        sequenceNum: null
      }]
    })
  }

  const invalidate = (targetProductId?: string) => {
  queryClient.invalidateQueries({ queryKey: qk.product.features(targetProductId ?? productId()) })

  if(parentProductId() !== (targetProductId ?? productId())) {
    queryClient.invalidateQueries({ queryKey: qk.product.features(parentProductId()) })
  }

  queryClient.invalidateQueries({ queryKey: qk.product.family(parentProductId()) })
  queryClient.invalidateQueries({ queryKey: qk.products.all, refetchType: "active" })
  
    triggerSolrIndex(parentProductId())
  }

  const snapshot = async () => {
    await queryClient.cancelQueries({ queryKey: listKey() })

    return queryClient.getQueryData<ProductFeatureApplication[]>(listKey())
  }

  const apply = useMutation({
    mutationFn: (payload: FeatureApply & { description?: string; featureTypeId?: string; featureTypeDescription?: string }) =>
      applyFeature(productId(), payload),
    onMutate: async (payload) => {
      const previous = await snapshot()
      queryClient.setQueryData<ProductFeatureApplication[]>(listKey(), (rows = []) => [
        ...rows,
        {
          productId: productId(),
          productFeatureId: payload.productFeatureId,
          productFeatureApplTypeId: payload.productFeatureApplTypeId ?? "STANDARD_FEATURE",
          featureTypeId: payload.featureTypeId ?? "",
          featureTypeDescription: payload.featureTypeDescription ?? payload.featureTypeId ?? "",
          description: payload.description ?? payload.productFeatureId,
          fromDate: new Date().toISOString(),
          thruDate: null,
          active: true,
          sequenceNum: payload.sequenceNum ?? null
        }
      ])

      return { previous }
    },
    onError: (_error, _payload, context) => queryClient.setQueryData(listKey(), context?.previous),
    onSettled: invalidate
  })

  const remove = useMutation({
    mutationFn: ({ productId, productFeatureId, fromDate }: { productId: string, productFeatureId: string; fromDate: string }) =>
      removeFeatureApplication(productId, productFeatureId, fromDate, DateTime.now().toMillis()),
    onMutate: async ({ productId: targetProductId, productFeatureId, fromDate }) => {
      const key = qk.product.features(targetProductId)
      await queryClient.cancelQueries({ queryKey: key })
      const previous = queryClient.getQueryData<ProductFeatureApplication[]>(key)

      queryClient.setQueryData<ProductFeatureApplication[]>(key, (rows = []) =>
        rows.map((row) =>
          row.productFeatureId === productFeatureId && row.fromDate === fromDate
            ? { ...row, thruDate: new Date().toISOString(), active: false }
            : row))

      return { previous, key }
    },
    onError: (_error, _payload, context) => {
      if(context?.key) {
        queryClient.setQueryData(context.key, context.previous)
      }
    },
      onSettled: (_data, _error, { productId: targetProductId }) => invalidate(targetProductId)
  })

  /** "add color" with a value that doesn't exist yet: create the catalog feature, then apply it. */
  const createAndApply = useMutation({
    mutationFn: async (payload: FeatureCreate & { productFeatureApplTypeId?: string }) => {
      const { productFeatureId } = await createFeature(payload)
      const applied = await applyFeature(productId(), { productFeatureId, productFeatureApplTypeId: payload.productFeatureApplTypeId }) as { fromDate?: unknown }

      return { productFeatureId, payload, fromDate: applied?.fromDate }
    },
    onSuccess: ({ productFeatureId, payload, fromDate }) => {
      cacheCreatedFeature(productFeatureId, payload)
      cacheCreatedFeatureApplication(productFeatureId, payload, fromDate)
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: qk.products.all, refetchType: "active" })
      queryClient.invalidateQueries({ queryKey: qk.product.family(parentProductId()) })
      queryClient.invalidateQueries({ queryKey: qk.catalog.features() })
      triggerSolrIndex(parentProductId())
    }
  })

  return { apply, remove, createAndApply }
}