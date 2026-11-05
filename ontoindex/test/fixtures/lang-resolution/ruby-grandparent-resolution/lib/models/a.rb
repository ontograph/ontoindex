require_relative 'greeting'

class A
  def untyped_greet
    Greeting.new
  end

  # @return [Greeting]
  def greet
    Greeting.new
  end
end
