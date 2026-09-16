import { reactive } from 'vue'

export const usePasswordVisibility = (fields = []) => {
  const visibility = reactive({})
  
  fields.forEach(field => {
    visibility[field] = false
  })

  const toggle = (field) => {
    if (visibility.hasOwnProperty(field)) {
      visibility[field] = !visibility[field]
    }
  }

  const show = (field) => {
    if (visibility.hasOwnProperty(field)) {
      visibility[field] = true
    }
  }

  const hide = (field) => {
    if (visibility.hasOwnProperty(field)) {
      visibility[field] = false
    }
  }

  const reset = () => {
    Object.keys(visibility).forEach(key => {
      visibility[key] = false
    })
  }

  const addField = (field) => {
    if (!visibility.hasOwnProperty(field)) {
      visibility[field] = false
    }
  }

  const getInputType = (field) => {
    return visibility[field] ? 'text' : 'password'
  }

  return {
    visibility,
    toggle,
    show,
    hide,
    reset,
    addField,
    getInputType
  }
}

export default usePasswordVisibility